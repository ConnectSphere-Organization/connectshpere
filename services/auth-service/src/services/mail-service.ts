import { config } from '../config/index.js';

export interface IMailOptions {
  to: string;
  subject: string;
  text?: string;
  html?: string;
}

export class MailService {
  private static transporter: any = null;
  private static readonly MAX_RETRIES = 3;
  private static readonly RETRY_DELAY_MS = 1000;

  private static async delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private static async getTransporter() {
    if (this.transporter) return this.transporter;

    let nodemailer;
    try {
      nodemailer = (await import('nodemailer')).default;
    } catch (err) {
      console.warn('[MailService] nodemailer module not found. Falling back to console log.');
      return null;
    }

    if (config.smtpService && config.smtpUser && config.smtpPass) {
      this.transporter = nodemailer.createTransport({
        service: config.smtpService,
        auth: {
          user: config.smtpUser.trim(),
          pass: config.smtpPass.trim().replace(/\s/g, ''), // Remove spaces from App Passwords
        },
      });

      return this.transporter;
    }

    if (config.smtpHost && config.smtpUser && config.smtpPass) {
      this.transporter = nodemailer.createTransport({
        host: config.smtpHost.trim(),
        port: config.smtpPort,
        secure: config.smtpPort === 465,
        auth: {
          user: config.smtpUser.trim(),
          pass: config.smtpPass.trim().replace(/\s/g, ''),
        },
      });

      return this.transporter;
    }


    console.warn('[MailService] Email credentials missing. Using console fallback.');
    return null;
  }

  static async sendMail(options: IMailOptions) {
    console.log(`[MailService] Preparing to send email to: ${options.to} (Subject: ${options.subject})`);
    const transporter = await this.getTransporter();

    const mailOptions = {
      from: config.smtpFrom,
      ...options,
    };

    console.log(`[MailService] Using From address: ${mailOptions.from}`);

    if (!transporter) {
      console.error(`[MailService:ERROR] SMTP is not configured. Email to ${options.to} was not sent.`);
      return { success: false, method: 'none', error: 'Email delivery is not configured' };
    }

    let lastError: any = null;
    for (let attempt = 1; attempt <= this.MAX_RETRIES; attempt++) {
      try {
        const info = await transporter.sendMail(mailOptions);
        console.log('[MailService] Email sent successfully to %s (attempt %d/%d): %s', options.to, attempt, this.MAX_RETRIES, info.messageId);
        return { success: true, method: 'smtp', messageId: info.messageId, attempt };
      } catch (error: any) {
        lastError = error;
        console.error('[MailService] Error sending email to %s (attempt %d/%d):', options.to, attempt, this.MAX_RETRIES, error.code, error.message);

        if (attempt < this.MAX_RETRIES) {
          const delayMs = this.RETRY_DELAY_MS * Math.pow(2, attempt - 1);
          console.log('[MailService] Retrying in %dms...', delayMs);
          await this.delay(delayMs);
        }
      }
    }

    console.error('[MailService] All %d attempts failed for %s:', this.MAX_RETRIES, options.to, lastError?.message);
    return { success: false, method: 'smtp', error: lastError?.message, attempts: this.MAX_RETRIES };
  }

  /**
   * Send a Workspace Invitation Email
   */
  static async sendInvitation(data: {
    to: string;
    inviterName: string;
    workspaceName: string;
    role: string;
    invitationUrl: string;
  }) {
    const { to, inviterName, workspaceName, role, invitationUrl } = data;

    return this.sendMail({
      to,
      subject: `You've been invited to join ${workspaceName} on ${config.appName}`,
      text: `Hello,\n\n${inviterName} has invited you to join the "${workspaceName}" workspace as a ${role}.\n\nAccept your invitation here: ${invitationUrl}\n\nWelcome aboard!`,
      html: `
        <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #eee; border-radius: 10px;">
          <h2 style="color: #6366f1;">Workspace Invitation</h2>
          <p>Hello,</p>
          <p><strong>${inviterName}</strong> has invited you to join the <strong>${workspaceName}</strong> workspace on ${config.appName}.</p>
          <p>Role: <span style="background: #f3f4f6; padding: 2px 8px; border-radius: 4px; font-weight: bold;">${role}</span></p>
          <div style="margin: 30px 0;">
            <a href="${invitationUrl}" style="background: #6366f1; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold;">Accept Invitation</a>
          </div>
          <p style="color: #6b7280; font-size: 0.875rem;">If you don't have an account, you'll be prompted to create one.</p>
          <hr style="border: 0; border-top: 1px solid #eee; margin: 20px 0;">
          <p style="color: #9ca3af; font-size: 0.75rem;">If you were not expecting this invitation, you can safely ignore this email.</p>
        </div>
      `,
    });
  }
}
