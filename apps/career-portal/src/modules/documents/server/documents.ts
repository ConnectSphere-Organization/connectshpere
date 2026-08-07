import "server-only";

import { createHash, randomBytes, randomUUID } from "node:crypto";

import { ApplicationStatus, OfferStatus } from "@prisma/client";

import {
  assertAssignedJob,
  type RecruitmentActor,
} from "@/lib/auth/authorization";
import { csvRecords, parseCsv, stringifyCsv } from "@/lib/csv";
import { prisma } from "@/lib/db/prisma";
import { ApiError } from "@/lib/http/api-error";
import { env } from "@/config/env";
import {
  certificateInputSchema,
  offerDecisionSchema,
  offerExtensionSchema,
  offerInputSchema,
  offerStatusSchema,
} from "@/modules/documents/schema";
import { canManageJobDocument } from "@/modules/documents/document-scope";
import {
  renderLegacyCertificatePdf,
  renderLegacyOfferPdf,
} from "@/modules/documents/server/legacy-pdf-renderers";
import {
  createOfferResponseToken,
  parseOfferResponseToken,
} from "@/modules/documents/server/offer-response-token";

const objectIdPattern = /^[a-f\d]{24}$/i;

function nullable(value: string): string | null {
  return value || null;
}
function tokenDigest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
function date(value: string): Date {
  return new Date(`${value}T12:00:00.000Z`);
}

export async function listCertificates(actor: RecruitmentActor) {
  return prisma.certificate.findMany({
    where: actor.isAdministrator
      ? {}
      : { jobId: { in: [...actor.assignedJobs] } },
    orderBy: { issuedOn: "desc" },
    select: {
      id: true,
      name: true,
      recipientEmail: true,
      domain: true,
      jobrole: true,
      fromDate: true,
      toDate: true,
      issuedBy: true,
      issuedOn: true,
      jobId: true,
      job: { select: { title: true } },
    },
  });
}

export async function issueCertificate(
  input: unknown,
  actor: RecruitmentActor,
) {
  const parsed = certificateInputSchema.parse(input);
  assertAssignedJob(actor, parsed.jobId);
  const job = await prisma.job.findUnique({
    where: { id: parsed.jobId },
    select: { id: true },
  });
  if (!job) throw new ApiError("Job not found", 404);
  const certificate = await prisma.certificate.create({
    data: {
      ...parsed,
      recipientEmail: nullable(parsed.recipientEmail),
      fromDate: date(parsed.fromDate),
      toDate: date(parsed.toDate),
      userId: actor.id,
    },
  });
  await prisma.auditLog.create({
    data: {
      actor: actor.id,
      actorRole: actor.role,
      action: "ISSUE",
      resourceEntity: "Certificate",
      resourceId: certificate.id,
      changes: {
        name: certificate.name,
        domain: certificate.domain,
        jobId: parsed.jobId,
      },
    },
  });
  return certificate;
}

export const certificateCsvHeaders = [
  "jobId",
  "name",
  "recipientEmail",
  "domain",
  "jobrole",
  "fromDate",
  "toDate",
  "issuedBy",
] as const;

export function certificateSampleCsv(): string {
  return stringifyCsv([
    certificateCsvHeaders,
    [
      "REPLACE_WITH_AUTHORIZED_JOB_ID",
      "Sample Employee",
      "employee@example.com",
      "Engineering",
      "Software Engineer",
      "2030-01-01",
      "2030-06-30",
      "ConnectSphere",
    ],
  ]);
}

export async function bulkIssueCertificates(
  csv: string,
  actor: RecruitmentActor,
): Promise<{
  total: number;
  succeeded: number;
  failed: number;
  results: BulkRowResult[];
}> {
  const records = csvRecords(parseCsv(csv), certificateCsvHeaders);
  if (records.length === 0)
    throw new ApiError("CSV contains no data rows", 400);
  const results: BulkRowResult[] = [];
  for (let index = 0; index < records.length; index += 1) {
    try {
      const certificate = await issueCertificate(records[index], actor);
      results.push({
        row: index + 2,
        success: true,
        id: certificate.id,
        reference: certificate.id,
      });
    } catch (error) {
      results.push({
        row: index + 2,
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Unable to issue certificate",
      });
    }
  }
  const succeeded = results.filter((result) => result.success).length;
  return {
    total: results.length,
    succeeded,
    failed: results.length - succeeded,
    results,
  };
}

export async function getPublicCertificate(id: string) {
  if (!objectIdPattern.test(id))
    throw new ApiError("Certificate not found", 404);
  const certificate = await prisma.certificate.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      domain: true,
      jobrole: true,
      fromDate: true,
      toDate: true,
      issuedBy: true,
      issuedOn: true,
    },
  });
  if (!certificate) throw new ApiError("Certificate not found", 404);
  return certificate;
}

export async function certificatePdf(id: string): Promise<Uint8Array> {
  const item = await getPublicCertificate(id);
  return renderLegacyCertificatePdf({
    id: item.id,
    name: item.name,
    jobrole: item.jobrole,
    domain: item.domain,
    fromDate: item.fromDate,
    toDate: item.toDate,
    issuedOn: item.issuedOn,
    verificationUrl: `${env.APP_URL}/verify/${item.id}`,
  });
}

export async function listOffers(actor: RecruitmentActor) {
  return prisma.offerLetter.findMany({
    where: actor.isAdministrator
      ? {}
      : { application: { is: { jobId: { in: [...actor.assignedJobs] } } } },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      shortId: true,
      candidateName: true,
      email: true,
      position: true,
      department: true,
      offerType: true,
      workType: true,
      status: true,
      issuedOn: true,
      validUntil: true,
      applicationId: true,
      extensionHistory: true,
      application: { select: { job: { select: { title: true } } } },
    },
  });
}

async function resolveApplication(identifier: string, actor: RecruitmentActor) {
  if (!identifier) return null;
  const application = await prisma.application.findFirst({
    where: objectIdPattern.test(identifier)
      ? { OR: [{ id: identifier }, { slug: identifier }] }
      : { slug: identifier },
    select: {
      id: true,
      jobId: true,
      userId: true,
      fullName: true,
      email: true,
      status: true,
    },
  });
  if (!application) throw new ApiError("Application not found", 404);
  assertAssignedJob(actor, application.jobId);
  if (
    application.status !== ApplicationStatus.SHORTLISTED &&
    application.status !== ApplicationStatus.OFFERED
  )
    throw new ApiError(
      "Only shortlisted or offered applications can receive an offer",
      409,
    );
  return application;
}

export async function issueOffer(input: unknown, actor: RecruitmentActor) {
  const parsed = offerInputSchema.parse(input);
  if (!actor.isAdministrator && !parsed.applicationId)
    throw new ApiError("Select an application from an assigned job", 403);
  const application = await resolveApplication(parsed.applicationId, actor);
  const existing = application
    ? await prisma.offerLetter.findFirst({
      where: { applicationId: application.id },
      select: { id: true },
    })
    : null;
  if (existing)
    throw new ApiError("An offer already exists for this application", 409);
  const acceptanceToken = randomBytes(32).toString("base64url");
  const shortId = `OFR-${randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()}`;
  const offer = await prisma.$transaction(async (transaction) => {
    const created = await transaction.offerLetter.create({
      data: {
        candidateName: application?.fullName ?? parsed.candidateName,
        email: application?.email ?? parsed.email,
        position: parsed.position,
        department: parsed.department,
        salary: parsed.salary,
        offerType: parsed.offerType,
        payoutFrequency: nullable(parsed.payoutFrequency),
        startDate: date(parsed.startDate),
        endDate: parsed.endDate ? date(parsed.endDate) : null,
        duration: nullable(parsed.duration),
        joiningLocation: nullable(parsed.joiningLocation),
        workType: parsed.workType,
        benefits: parsed.benefits
          .split("\n")
          .map((item) => item.trim())
          .filter(Boolean),
        reportingManager: nullable(parsed.reportingManager),
        companyName: parsed.companyName,
        hrContactName: nullable(parsed.hrContactName),
        hrContactEmail: nullable(parsed.hrContactEmail),
        hrContactPhone: nullable(parsed.hrContactPhone),
        issuedBy: parsed.issuedBy,
        validUntil: date(parsed.validUntil),
        additionalNotes: nullable(parsed.additionalNotes),
        applicationId: application?.id ?? null,
        userId: application?.userId ?? null,
        shortId,
        acceptanceToken: tokenDigest(acceptanceToken),
      },
      select: {
        id: true,
        shortId: true,
        candidateName: true,
        email: true,
        position: true,
        department: true,
        offerType: true,
        workType: true,
        status: true,
        issuedOn: true,
        validUntil: true,
        applicationId: true,
        extensionHistory: true,
      },
    });
    if (application)
      await transaction.application.update({
        where: { id: application.id },
        data: {
          status: ApplicationStatus.OFFERED,
          offerLetterId: created.id,
          offerLetter: created.id,
          updatedAt: new Date(),
        },
      });
    await transaction.auditLog.create({
      data: {
        actor: actor.id,
        actorRole: actor.role,
        action: "ISSUE",
        resourceEntity: "OfferLetter",
        resourceId: created.id,
        changes: { shortId, applicationId: application?.id ?? null },
      },
    });
    return created;
  });
  return { offer, acceptanceToken };
}

export async function getOfferForActor(id: string, actor: RecruitmentActor) {
  if (!objectIdPattern.test(id)) throw new ApiError("Offer not found", 404);
  const offer = await prisma.offerLetter.findUnique({
    where: { id },
    select: {
      id: true,
      shortId: true,
      candidateName: true,
      email: true,
      position: true,
      department: true,
      salary: true,
      offerType: true,
      payoutFrequency: true,
      startDate: true,
      endDate: true,
      duration: true,
      joiningLocation: true,
      workType: true,
      benefits: true,
      reportingManager: true,
      companyName: true,
      hrContactName: true,
      hrContactEmail: true,
      hrContactPhone: true,
      issuedBy: true,
      issuedOn: true,
      updatedAt: true,
      status: true,
      validUntil: true,
      additionalNotes: true,
      acceptanceToken: true,
      extensionHistory: true,
      application: { select: { jobId: true } },
    },
  });
  if (!offer) throw new ApiError("Offer not found", 404);
  if (
    !canManageJobDocument({
      isAdministrator: actor.isAdministrator,
      assignedJobs: actor.assignedJobs,
      jobId: offer.application?.jobId,
    })
  )
    throw new ApiError("Offer is outside your assigned job scope", 403);
  return offer;
}

export async function offerPdf(
  id: string,
  actor: RecruitmentActor,
): Promise<Uint8Array> {
  const item = await getOfferForActor(id, actor);
  return renderLegacyOfferPdf({
    id: item.id,
    candidateName: item.candidateName,
    position: item.position,
    department: item.department,
    salary: item.salary,
    offerType: item.offerType,
    payoutFrequency: item.payoutFrequency,
    startDate: item.startDate,
    endDate: item.endDate,
    duration: item.duration,
    joiningLocation: item.joiningLocation,
    workType: item.workType,
    reportingManager: item.reportingManager,
    createdAt: item.issuedOn,
    validUntil: item.validUntil,
    extensionCount: 0,
    hrContactName: item.hrContactName,
    issuedBy: item.issuedBy,
    verificationUrl: `${env.APP_URL}/verify-offer/${item.id}`,
  });
}

export async function getPublicOfferByToken(token: string) {
  if (token.length < 32 || token.length > 200)
    throw new ApiError("Offer link is invalid", 404);
  const signed = parseOfferResponseToken(token, env.BETTER_AUTH_SECRET);
  const offer = signed
    ? await prisma.offerLetter.findUnique({
      where: { id: signed.offerId },
      select: {
        id: true,
        shortId: true,
        candidateName: true,
        position: true,
        department: true,
        companyName: true,
        offerType: true,
        workType: true,
        startDate: true,
        validUntil: true,
        status: true,
        acceptanceToken: true,
        contractId: true,
      },
    })
    : await prisma.offerLetter.findUnique({
      where: { acceptanceToken: tokenDigest(token) },
      select: {
        id: true,
        shortId: true,
        candidateName: true,
        position: true,
        department: true,
        companyName: true,
        offerType: true,
        workType: true,
        startDate: true,
        validUntil: true,
        status: true,
        acceptanceToken: true,
        contractId: true,
      },
    });
  if (!offer) throw new ApiError("Offer link is invalid", 404);
  if (signed && signed.expiresAt.getTime() !== offer.validUntil.getTime())
    throw new ApiError("Offer link is invalid", 404);
  if (
    offer.contractId ||
    (offer.status === OfferStatus.ACCEPTED &&
      offer.acceptanceToken !== tokenDigest(token))
  )
    throw new ApiError("Offer link has already been completed", 404);
  return {
    id: offer.id,
    shortId: offer.shortId,
    candidateName: offer.candidateName,
    position: offer.position,
    department: offer.department,
    companyName: offer.companyName,
    offerType: offer.offerType,
    workType: offer.workType,
    startDate: offer.startDate,
    validUntil: offer.validUntil,
    status: offer.status,
    isExpired: offer.validUntil.getTime() < Date.now(),
  };
}

export async function decideOffer(token: string, input: unknown) {
  const offer = await getPublicOfferByToken(token);
  const parsed = offerDecisionSchema.parse(input);
  if (offer.status !== OfferStatus.PENDING)
    throw new ApiError("This offer has already been answered", 409);
  if (offer.validUntil.getTime() < Date.now())
    throw new ApiError("This offer link has expired", 410);
  if (parsed.decision === OfferStatus.ACCEPTED) {
    return {
      status: OfferStatus.PENDING,
      contractOnboarding: `/contract/onboarding/${token}`,
    };
  }
  const now = new Date();
  const signed = parseOfferResponseToken(token, env.BETTER_AUTH_SECRET);
  const result = await prisma.offerLetter.updateMany({
    where: {
      id: offer.id,
      status: OfferStatus.PENDING,
      ...(signed
        ? { validUntil: signed.expiresAt }
        : { acceptanceToken: tokenDigest(token) }),
      validUntil: { gte: now },
    },
    data: {
      status: OfferStatus.REJECTED,
      rejectedAt: now,
      acceptanceComments: nullable(parsed.comments),
      acceptanceToken: null,
      onboardingDraft: null,
      draftUpdatedAt: null,
      draftDocuments: [],
    },
  });
  if (result.count !== 1)
    throw new ApiError("Offer changed or expired; reload the page", 409);
  return { status: OfferStatus.REJECTED, contractOnboarding: null };
}

export async function decideOwnedOffer(
  offerId: string,
  userId: string,
  input: unknown,
) {
  if (!objectIdPattern.test(offerId))
    throw new ApiError("Offer not found", 404);
  const parsed = offerDecisionSchema.parse(input);
  const offer = await prisma.offerLetter.findFirst({
    where: {
      id: offerId,
      OR: [{ userId }, { application: { is: { userId } } }],
    },
    select: { id: true, status: true, validUntil: true, applicationId: true },
  });
  if (!offer) throw new ApiError("Offer not found", 404);
  if (offer.status !== OfferStatus.PENDING)
    throw new ApiError("This offer has already been answered", 409);
  const now = new Date();
  if (offer.validUntil.getTime() < now.getTime())
    throw new ApiError("This offer has expired", 410);
  if (parsed.decision === OfferStatus.ACCEPTED) {
    const onboardingToken = createOfferResponseToken(
      offer.id,
      offer.validUntil,
      env.BETTER_AUTH_SECRET,
    );
    await prisma.offerLetter.update({
      where: { id: offer.id },
      data: { acceptanceToken: tokenDigest(onboardingToken) },
    });
    return {
      status: OfferStatus.PENDING,
      contractOnboarding: `/contract/onboarding/${onboardingToken}`,
    };
  }
  const result = await prisma.offerLetter.updateMany({
    where: {
      id: offer.id,
      status: OfferStatus.PENDING,
      validUntil: { gte: now },
    },
    data: {
      status: OfferStatus.REJECTED,
      acceptedAt: null,
      rejectedAt: now,
      acceptanceComments: nullable(parsed.comments),
      acceptanceToken: null,
      onboardingDraft: null,
      draftUpdatedAt: null,
      draftDocuments: [],
    },
  });
  if (result.count !== 1)
    throw new ApiError("Offer changed or expired; reload the page", 409);
  if (offer.applicationId && parsed.decision === OfferStatus.REJECTED) {
    await prisma.application.updateMany({
      where: { id: offer.applicationId, userId },
      data: { status: ApplicationStatus.REJECTED, updatedAt: now },
    });
  }
  return {
    status: OfferStatus.REJECTED,
    contractOnboarding: null,
  };
}

export const offerCsvHeaders = [
  "candidateName",
  "email",
  "position",
  "department",
  "salary",
  "offerType",
  "payoutFrequency",
  "startDate",
  "endDate",
  "duration",
  "joiningLocation",
  "workType",
  "benefits",
  "reportingManager",
  "companyName",
  "hrContactName",
  "hrContactEmail",
  "hrContactPhone",
  "issuedBy",
  "validUntil",
  "additionalNotes",
  "applicationId",
] as const;

export function offerSampleCsv(): string {
  return stringifyCsv([
    offerCsvHeaders,
    [
      "Sample Candidate",
      "candidate@example.com",
      "Software Engineer",
      "Engineering",
      "INR 12,00,000",
      "JOB",
      "annual",
      "2030-01-10",
      "",
      "",
      "Remote",
      "REMOTE",
      "Health insurance",
      "Manager",
      "ConnectSphere",
      "HR Team",
      "hr@example.com",
      "",
      "ConnectSphere",
      "2030-01-05",
      "",
      "",
    ],
  ]);
}

export type BulkRowResult = {
  row: number;
  success: boolean;
  id?: string;
  reference?: string | null;
  error?: string;
};

export async function bulkIssueOffers(
  csv: string,
  actor: RecruitmentActor,
): Promise<{
  total: number;
  succeeded: number;
  failed: number;
  results: BulkRowResult[];
}> {
  const records = csvRecords(parseCsv(csv), offerCsvHeaders);
  if (records.length === 0)
    throw new ApiError("CSV contains no data rows", 400);
  const results: BulkRowResult[] = [];
  for (let index = 0; index < records.length; index += 1) {
    try {
      const result = await issueOffer(records[index], actor);
      results.push({
        row: index + 2,
        success: true,
        id: result.offer.id,
        reference: result.offer.shortId,
      });
    } catch (error) {
      results.push({
        row: index + 2,
        success: false,
        error: error instanceof Error ? error.message : "Unable to issue offer",
      });
    }
  }
  const succeeded = results.filter((result) => result.success).length;
  return {
    total: results.length,
    succeeded,
    failed: results.length - succeeded,
    results,
  };
}

export async function extendOffer(
  id: string,
  input: unknown,
  actor: RecruitmentActor,
) {
  const parsed = offerExtensionSchema.parse(input);
  const offer = await getOfferForActor(id, actor);
  if (offer.status !== OfferStatus.PENDING)
    throw new ApiError("Only pending offers can be extended", 409);
  const newValidUntil = date(parsed.validUntil);
  const newStartDate = parsed.startDate
    ? date(parsed.startDate)
    : offer.startDate;
  const snapshot = {
    validUntil: offer.validUntil.toISOString(),
    startDate: offer.startDate.toISOString(),
    status: offer.status,
  };
  const extension = {
    id: randomBytes(12).toString("hex"),
    oldValidUntil: offer.validUntil,
    newValidUntil,
    oldStartDate: offer.startDate,
    newStartDate,
    notes: parsed.notes,
    previousOfferSnapshot: snapshot,
    updatedOfferSnapshot: {
      ...snapshot,
      validUntil: newValidUntil.toISOString(),
      startDate: newStartDate.toISOString(),
    },
    extendedAt: new Date(),
    extendedBy: actor.id,
  };
  await prisma.offerLetter.update({
    where: { id },
    data: {
      validUntil: newValidUntil,
      startDate: newStartDate,
      extensionHistory: { push: extension },
    },
  });
  await prisma.auditLog.create({
    data: {
      actor: actor.id,
      actorRole: actor.role,
      action: "UPDATE",
      resourceEntity: "OfferLetter",
      resourceId: id,
      changes: {
        operation: "extend",
        oldValidUntil: snapshot.validUntil,
        newValidUntil: newValidUntil.toISOString(),
      },
    },
  });
  return extension;
}

export async function updateOfferStatus(
  id: string,
  input: unknown,
  actor: RecruitmentActor,
) {
  const parsed = offerStatusSchema.parse(input);
  const offer = await getOfferForActor(id, actor);
  if (offer.status !== OfferStatus.PENDING)
    throw new ApiError("A final offer status cannot be changed", 409);
  if (parsed.status === OfferStatus.PENDING)
    throw new ApiError("Offer is already pending", 409);
  const now = new Date();
  const result = await prisma.offerLetter.updateMany({
    where: { id, status: OfferStatus.PENDING },
    data: {
      status: parsed.status,
      acceptedAt: parsed.status === OfferStatus.ACCEPTED ? now : null,
      rejectedAt: parsed.status === OfferStatus.REJECTED ? now : null,
      acceptanceComments: parsed.reason,
      acceptanceToken: null,
    },
  });
  if (result.count !== 1)
    throw new ApiError("Offer changed; refresh and retry", 409);
  await prisma.auditLog.create({
    data: {
      actor: actor.id,
      actorRole: actor.role,
      action:
        parsed.status === OfferStatus.REJECTED ? "REJECT" : "STATUS_CHANGE",
      resourceEntity: "OfferLetter",
      resourceId: id,
      changes: {
        oldStatus: offer.status,
        newStatus: parsed.status,
        reason: parsed.reason,
      },
    },
  });
  return { status: parsed.status };
}

export async function regenerateOfferToken(
  id: string,
  actor: RecruitmentActor,
): Promise<string> {
  const offer = await getOfferForActor(id, actor);
  if (offer.status !== OfferStatus.PENDING)
    throw new ApiError(
      "Only pending offers can receive a new response link",
      409,
    );
  if (offer.validUntil.getTime() < Date.now())
    throw new ApiError(
      "Extend the expired offer before regenerating its link",
      409,
    );
  const token = randomBytes(32).toString("base64url");
  await prisma.offerLetter.update({
    where: { id },
    data: { acceptanceToken: tokenDigest(token) },
  });
  await prisma.auditLog.create({
    data: {
      actor: actor.id,
      actorRole: actor.role,
      action: "UPDATE",
      resourceEntity: "OfferLetter",
      resourceId: id,
      changes: { operation: "regenerate-token" },
    },
  });
  return token;
}

