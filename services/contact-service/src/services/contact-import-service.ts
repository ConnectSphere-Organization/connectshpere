import mongoose from 'mongoose';
import { Contact, ImportJob } from '../models/index.js';

export interface ContactImportProgress {
  jobId: string;
  fileName: string;
  totalRows: number;
  processedRows: number;
  successfulRows: number;
  failedRows: number;
  errors: Array<{ row: number; error: string }>;
  status: 'started' | 'in-progress' | 'completed' | 'failed';
  startedAt: Date;
  completedAt?: Date;
}

export function parseCSV(content: string): string[][] {
  const lines: string[][] = [];
  let row: string[] = [];
  let inQuotes = false;
  let currentVal = '';
  const maxLen = Math.min(content ? content.length : 0, 50 * 1024 * 1024);

  for (let i = 0; i < maxLen; i++) {
    const char = content[i];
    const nextChar = content[i + 1];

    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        currentVal += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      row.push(currentVal.trim());
      currentVal = '';
    } else if ((char === '\r' || char === '\n') && !inQuotes) {
      if (char === '\r' && nextChar === '\n') i++;
      row.push(currentVal.trim());
      lines.push(row);
      row = [];
      currentVal = '';
    } else {
      currentVal += char;
    }
  }
  if (currentVal || row.length > 0) {
    row.push(currentVal.trim());
    lines.push(row);
  }
  return lines;
}

class ContactImportService {
  async startImport(
    workspaceId: string,
    fileName: string,
    csvContent: string
  ): Promise<string> {
    const lines = parseCSV(csvContent).filter(l => l.length > 0 && l.some(cell => cell.trim().length > 0));
    if (lines.length < 2) {
      throw new Error('No valid contacts found in CSV file');
    }

    const headers = lines[0].map(h => h.toLowerCase().trim());
    const dataRows = lines.slice(1);

    const jobId = 'import_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7);

    await ImportJob.create({
      jobId,
      workspace: new mongoose.Types.ObjectId(workspaceId),
      fileName,
      totalRows: dataRows.length,
      processedRows: 0,
      successfulRows: 0,
      failedRows: 0,
      errors: [],
      status: 'started',
      startedAt: new Date(),
    });

    // Asynchronously trigger background processing
    this.processImport(jobId, workspaceId, headers, dataRows).catch(err => {
      console.error(`[Contact CSV Import] Background job ${jobId} failed:`, err);
    });

    return jobId;
  }

  private async processImport(
    jobId: string,
    workspaceId: string,
    headers: string[],
    dataRows: string[][]
  ) {
    try {
      await ImportJob.updateOne({ jobId }, { $set: { status: 'in-progress' } });

      let processedRows = 0;
      let successfulRows = 0;
      let failedRows = 0;
      const errors: Array<{ row: number; error: string }> = [];
      let rowNumber = 1;

      for (const rowData of dataRows) {
        rowNumber++;
        try {
          const record: Record<string, string> = {};
          headers.forEach((header, index) => {
            if (rowData[index] !== undefined) {
              record[header] = rowData[index];
            }
          });

          const rawPhone = record.phone || record.Phone || '';
          const rawPhoneClean = rawPhone.replace(/\D/g, '');
          if (!rawPhoneClean) {
            throw new Error('Phone number is required and must contain digits');
          }

          const name = record.name || record.Name || 'Unknown';
          const tags = record.tags ? record.tags.split(',').map((t: string) => t.trim()).filter(Boolean) : [];
          const email = record.email || record.Email || '';
          const leadStatus = record.leadstatus || record.leadStatus || 'new';

          await (Contact as any).findOneAndUpdate(
            { phone: rawPhoneClean, workspace: workspaceId },
            {
              $set: {
                name,
                leadStatus,
                'metadata.email': email || undefined,
              },
              $addToSet: { tags: { $each: tags } }
            },
            { upsert: true, new: true }
          );

          successfulRows++;
        } catch (err: any) {
          failedRows++;
          if (errors.length < 10) {
            errors.push({
              row: rowNumber,
              error: err.message,
            });
          }
        } finally {
          processedRows++;
          if (processedRows % 10 === 0 || processedRows === dataRows.length) {
            await ImportJob.updateOne(
              { jobId },
              {
                $set: {
                  processedRows,
                  successfulRows,
                  failedRows,
                  errors,
                }
              }
            );
          }
        }
      }

      await ImportJob.updateOne(
        { jobId },
        {
          $set: {
            status: 'completed',
            completedAt: new Date(),
            processedRows,
            successfulRows,
            failedRows,
            errors,
          }
        }
      );
    } catch (err: any) {
      console.error(`[Contact CSV Import] Process failed for job ${jobId}:`, err?.message);
      await ImportJob.updateOne(
        { jobId },
        {
          $set: {
            status: 'failed',
            completedAt: new Date(),
          }
        }
      ).catch(() => {});
    }
  }

  async getProgress(jobId: string): Promise<ContactImportProgress | null> {
    const job = (await ImportJob.findOne({ jobId }).lean()) as any;
    if (!job) return null;
    return {
      jobId: job.jobId,
      fileName: job.fileName,
      totalRows: job.totalRows,
      processedRows: job.processedRows,
      successfulRows: job.successfulRows,
      failedRows: job.failedRows,
      errors: job.errors,
      status: job.status as any,
      startedAt: job.startedAt,
      completedAt: job.completedAt
    };
  }

  async cancelImport(jobId: string): Promise<void> {
    await ImportJob.updateOne(
      { jobId },
      {
        $set: {
          status: 'failed',
          completedAt: new Date(),
        }
      }
    );
  }
}

export const contactImportService = new ContactImportService();
export default contactImportService;
