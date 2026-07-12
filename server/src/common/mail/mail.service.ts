import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SystemSettingsService } from '../../modules/system-settings/system-settings.service';
import { Resend } from 'resend';

interface MailOptions {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  from?: string;
  attachments?: Array<{ filename: string; content: any }>; // kept for compatibility, but Resend uses different format
}

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly frontendUrl: string;
  private readonly defaultFrom: string;

  constructor(
    private configService: ConfigService,
    private readonly resend: Resend,
    private systemSettingsService: SystemSettingsService,
  ) {
    this.frontendUrl = this.configService.get<string>('FRONTEND_URL', 'http://localhost:5173');
    this.defaultFrom = this.configService.get<string>('RESEND_FROM_EMAIL', 'no-reply@theafricanthinktank.com');
  }

  /**
   * Core method to send emails via Resend
   */
  private async sendResendEmail(options: MailOptions): Promise<any> {
    const from = options.from || this.defaultFrom;
    const to = Array.isArray(options.to) ? options.to : [options.to];

    this.logger.debug(`Sending email via Resend: to=${to.join(',')}, subject=${options.subject}`);

    try {
      const { error, data } = await this.resend.emails.send({
        from,
        to,
        subject: options.subject,
        html: options.html,
        text: options.text || undefined,
        // Resend attachments format differs – we can convert if needed, but for now omit
        // attachments: options.attachments ? ... 
      });

      if (error) {
        this.logger.error(`Resend error: ${error.message}`);
        throw error;
      }

      // Atomic increment of total emails sent on success
      try {
        const currentCount = parseInt(
          (await this.systemSettingsService.getRawValue('TOTAL_EMAILS_SENT')) || '0',
          10,
        );
        await this.systemSettingsService.update(
          'TOTAL_EMAILS_SENT',
          (currentCount + 1).toString(),
          'TELEMETRY',
          'Total successful transactional emails sent by the platform.',
          false,
        );
      } catch (telemetryError) {
        this.logger.error('Failed to update email telemetry counter', telemetryError);
      }

      this.logger.log(`✅ Email sent successfully via Resend: ${data?.id}`);
      return data;
    } catch (error) {
      this.logger.error(`Failed to send email via Resend: ${error.message}`);
      throw error;
    }
  }

  // ---------------------- Public methods ----------------------

  async sendAdminInvite(email: string, firstName: string, token: string) {
    const inviteLink = `${this.frontendUrl}/auth/complete-registration?token=${token}`;

    const html = `<!DOCTYPE html>
<html>
    <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>TATT Invitation</title>
    </head>
    <body style="margin: 0; padding: 20px; background-color: #f4f4f4;">
        <div style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; max-width: 600px; margin: auto; padding: 40px; background-color: #000000; color: #ffffff; border-radius: 24px; border: 1px solid #333;">
            <div style="text-align: center; margin-bottom: 30px;">
                <h1 style="color: #ADFF2F; font-size: 28px; font-weight: 900; text-transform: uppercase; letter-spacing: -1px; margin: 0;">The African Think Tank</h1>
                <p style="color: #888; font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: 2px; margin-top: 8px;">Secure Invitation Portal</p>
            </div>
            
            <h2 style="font-size: 22px; font-weight: 800; margin-bottom: 20px;">Hello ${firstName},</h2>
            <p style="color: #ccc; font-size: 16px; line-height: 1.6;">You have been formally invited to join the leadership and management platform for the <strong>African Think Tank Community</strong>.</p>
            <p style="color: #ccc; font-size: 16px; line-height: 1.6;">To finalize your appointment and gain access to the administrative dashboard, please activate your account using the secure link below:</p>
            
            <p style="text-align: center; margin: 40px 0;">
                <a href="${inviteLink}" style="background-color: #ADFF2F; color: #000; padding: 18px 40px; text-decoration: none; border-radius: 12px; font-weight: 900; text-transform: uppercase; letter-spacing: 1px; font-size: 14px; display: inline-block; box-shadow: 0 4px 14px rgba(173, 255, 47, 0.2);">
                    Activate Your Account
                </a>
            </p>
            
            <div style="background-color: #111; padding: 20px; border-radius: 12px; border: 1px solid #333; margin-top: 40px;">
                <p style="color: #888; font-size: 12px; margin: 0; line-height: 1.5;">This invitation was dispatched to <strong>${email}</strong>. If you were not expecting this, please notify your system administrator immediately.</p>
            </div>
        </div>
    </body>
</html>`;

    try {
      await this.sendResendEmail({
        to: email,
        subject: 'Action Required: Your TATT Leadership Invitation',
        html,
        text: `Hello ${firstName},\n\nYou have been formally invited to join the leadership and management platform for the African Think Tank Community.\n\nTo finalize your appointment and gain access to the administrative dashboard, please activate your account using the following link:\n\n${inviteLink}\n\nThis invitation was dispatched to ${email}. If you were not expecting this, please notify your system administrator immediately.\n\nThe African Think Tank`,
      });
      this.logger.log(`Admin Invite email dispatched successfully to ${email}`);
    } catch (error) {
      this.logger.error(`Failed to send invite email to ${email}`, error.stack);
      throw new Error(`Failed to send email: ${error.message}`);
    }
  }

  async sendPasswordReset(email: string, token: string) {
    const resetLink = `${this.frontendUrl}/reset-password?token=${token}`;

    try {
      await this.sendResendEmail({
        to: email,
        subject: 'TATT Password Reset Request',
        html: `
          <h2>Password Reset</h2>
          <p>We received a request to reset your password for your TATT account.</p>
          <p>Click the link below to set a new password. This link expires in 1 Hour.</p>
          <p><a href="${resetLink}" style="padding: 10px 20px; background-color: #cc0000; color: #fff; text-decoration: none; border-radius: 5px;">Reset Password</a></p>
          <br/>
          <p>If you did not request this, you can safely ignore this email.</p>
        `,
      });
      this.logger.log(`✅ Password reset email sent to ${email}`);
    } catch (error) {
      this.logger.error(`❌ Failed to send reset email: ${error.message}`);
      throw error;
    }
  }

  async sendSubscriptionDowngradeNotice(email: string, firstName: string, reason: string) {
    try {
      await this.sendResendEmail({
        to: email,
        subject: 'Your TATT Membership Has Been Updated',
        html: `
          <h2>Hi ${firstName},</h2>
          <p>We regret to inform you that your TATT membership has been downgraded to the <strong>Free tier</strong>.</p>
          <p><strong>Reason:</strong> ${reason === 'past_due' ? 'Payment past due' : 'Subscription canceled or unpaid'}</p>
          <p>You can re-subscribe at any time from your member dashboard to restore access to premium content and features.</p>
          <br/>
          <p>Thank you for being part of the TATT community.</p>
        `,
      });
      this.logger.log(`Downgrade notice sent to ${email}`);
    } catch (error) {
      this.logger.error(`Failed to send downgrade notice to ${email}`, error.stack);
    }
  }

  async sendRenewalReminder(email: string, firstName: string, expiresAt: Date) {
    const expiryStr = expiresAt.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    const renewLink = `${this.frontendUrl}/member/subscription`;

    try {
      await this.sendResendEmail({
        to: email,
        subject: 'Your TATT Membership is Expiring Soon',
        html: `
          <h2>Hi ${firstName},</h2>
          <p>Your TATT membership is set to expire on <strong>${expiryStr}</strong>.</p>
          <p>Since you don't have auto-pay enabled, please renew your subscription manually to avoid losing access to member benefits.</p>
          <p><a href="${renewLink}" style="padding: 10px 20px; background-color: #0044cc; color: #fff; text-decoration: none; border-radius: 5px;">Renew Now</a></p>
          <br/>
          <p>Thank you for being a valued member of the TATT community.</p>
        `,
      });
      this.logger.log(`Renewal reminder sent to ${email}`);
    } catch (error) {
      this.logger.error(`Failed to send renewal reminder to ${email}`, error.stack);
    }
  }

  async sendConnectionRequest(
    recipientEmail: string,
    recipientFirstName: string,
    senderFullName: string,
    message: string,
  ) {
    const profileLink = `${this.frontendUrl}/member/network/requests`;

    try {
      await this.sendResendEmail({
        to: recipientEmail,
        subject: `${senderFullName} wants to connect with you on TATT`,
        html: `
          <h2>Hi ${recipientFirstName},</h2>
          <p><strong>${senderFullName}</strong> has sent you a connection request on The African Think Tank platform.</p>
          <blockquote style="border-left: 4px solid #0044cc; padding-left: 16px; color: #555; margin: 16px 0;">
            &ldquo;${message}&rdquo;
          </blockquote>
          <p>Review their profile and decide whether you'd like to connect:</p>
          <p>
            <a href="${profileLink}" style="padding: 10px 20px; background-color: #0044cc; color: #fff; text-decoration: none; border-radius: 5px;">
              View Connection Request
            </a>
          </p>
          <br/>
          <p>If you do not wish to connect, you can simply decline the request from your dashboard.</p>
          <p>Thank you for being a valued member of the TATT community.</p>
        `,
      });
      this.logger.log(`Connection request email sent to ${recipientEmail} from ${senderFullName}`);
    } catch (error) {
      this.logger.error(`Failed to send connection request email to ${recipientEmail}`, error.stack);
      throw error;
    }
  }

  async sendTwoFactorOtp(email: string, firstName: string, otp: string) {
    try {
      await this.sendResendEmail({
        to: email,
        subject: 'Your TATT Sign-In Verification Code',
        html: `
          <h2>Hi ${firstName},</h2>
          <p>Your verification code for The African Think Tank platform is:</p>
          <div style="text-align:center; margin: 24px 0;">
            <span style="font-size: 36px; font-weight: bold; letter-spacing: 8px; color: #0044cc; font-family: monospace;">
              ${otp}
            </span>
          </div>
          <p>This code expires in <strong>10 minutes</strong> and can only be used once.</p>
          <p style="color: #cc0000;"><strong>Do not share this code with anyone.</strong> TATT staff will never ask for your code.</p>
          <br/>
          <p>If you did not attempt to sign in, please secure your account immediately by resetting your password.</p>
        `,
      });
      this.logger.log(`2FA OTP email sent to ${email}`);
    } catch (error) {
      this.logger.error(`Failed to send 2FA OTP to ${email}`, error.stack);
      throw error;
    }
  }

  async sendPasswordExpiryWarning(email: string, firstName: string, expiresAt: Date, timeframe: string) {
    const expiryStr = expiresAt.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    const changeLink = `${this.frontendUrl}/auth/password/change`;

    try {
      await this.sendResendEmail({
        to: email,
        subject: `Action Required: Your TATT password expires in ${timeframe}`,
        html: `
          <h2>Hi ${firstName},</h2>
          <p>Your TATT account password is set to expire on <strong>${expiryStr}</strong> — that's in <strong>${timeframe}</strong>.</p>
          <p>To avoid being locked out, please update your password before it expires:</p>
          <p>
            <a href="${changeLink}" style="padding: 10px 20px; background-color: #cc6600; color: #fff; text-decoration: none; border-radius: 5px;">
              Change My Password
            </a>
          </p>
          <br/>
          <p style="color: #555; font-size: 14px;">
            This is a security policy reminder. If you have already changed your password recently,
            you can disregard this notice.
          </p>
          <p>Thank you for keeping your account secure.</p>
        `,
      });
      this.logger.log(`Password expiry warning (${timeframe}) sent to ${email}`);
    } catch (error) {
      this.logger.error(`Failed to send password expiry warning to ${email}`, error.stack);
    }
  }

  async sendEventNotification(email: string, firstName: string, eventTitle: string, eventDate: string, eventType: string, eventId: string) {
    const eventLink = `${this.frontendUrl}/events/${eventId}`;

    try {
      await this.sendResendEmail({
        to: email,
        subject: `New ${eventType} Announced: ${eventTitle}`,
        html: `
          <h2>Hi ${firstName},</h2>
          <p>A new <strong>${eventType}</strong> has been scheduled for the TATT community!</p>
          <div style="background-color: #f4f4f4; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <h3 style="margin-top: 0; color: #0044cc;">${eventTitle}</h3>
            <p><strong>Date:</strong> ${eventDate}</p>
            <p>Join us for this special gathering! Click the button below to view details and register:</p>
            <p>
              <a href="${eventLink}" style="padding: 10px 20px; background-color: #0044cc; color: #fff; text-decoration: none; border-radius: 5px; display: inline-block;">
                View Event Details
              </a>
            </p>
          </div>
          <p>We look forward to seeing you there!</p>
          <p>Thank you,<br/>The TATT Team</p>
        `,
      });
      this.logger.log(`Event notification email sent to ${email} for event: ${eventTitle}`);
    } catch (error) {
      this.logger.error(`Failed to send event notification email to ${email}`, error.stack);
    }
  }

  async sendNotificationEmail(email: string, firstName: string, title: string, message: string, actionLink?: string, actionLabel?: string) {
    try {
      await this.sendResendEmail({
        to: email,
        subject: `TATT: ${title}`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 20px; border: 1px solid #eee; border-radius: 10px;">
            <h2 style="color: #0044cc;">Hello ${firstName},</h2>
            <p style="font-size: 16px; line-height: 1.6; color: #333;">${message}</p>
            ${actionLink ? `
              <div style="margin: 30px 0; text-align: center;">
                <a href="${actionLink}" style="padding: 12px 24px; background-color: #0044cc; color: #ffffff; text-decoration: none; border-radius: 8px; font-weight: bold;">
                  ${actionLabel || 'View Details'}
                </a>
              </div>
            ` : ''}
            <hr style="border: 0; border-top: 1px solid #eee; margin: 30px 0;">
            <p style="font-size: 12px; color: #888;">You received this email because of your TATT account notification settings. Log in to your dashboard to manage your notifications.</p>
            <p style="font-size: 12px; color: #888; margin-top: 10px;">&copy; ${new Date().getFullYear()} The African Think Tank. All rights reserved.</p>
          </div>
        `,
      });
      this.logger.log(`Notification email sent to ${email}: ${title}`);
    } catch (error) {
      this.logger.error(`Failed to send notification email to ${email}`, error.stack);
    }
  }

  async sendDailyDigest(email: string, firstName: string, platformPosts: number, chapterPosts: number, chapterName?: string) {
    try {
      await this.sendResendEmail({
        to: email,
        subject: `Daily Community Update — ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`,
        html: `
          <div style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; max-width: 600px; margin: auto; padding: 40px; background-color: #ffffff; border: 1px solid #e1e1e1; border-radius: 20px;">
            <div style="text-align: center; margin-bottom: 30px;">
              <h1 style="color: #000; font-weight: 900; text-transform: uppercase; letter-spacing: -1px; margin: 0;">TATT Community</h1>
              <p style="color: #666; font-size: 14px; margin-top: 5px;">Daily Digest • ${new Date().toLocaleDateString()}</p>
            </div>
            
            <h2 style="color: #000; font-size: 24px; font-weight: 800; margin-bottom: 20px;">Hi ${firstName},</h2>
            <p style="color: #444; font-size: 16px; line-height: 1.6;">The TATT ecosystem has been active today! Here's a snapshot of what's new in your professional network:</p>
            
            <div style="background-color: #f7f9fc; padding: 25px; border-radius: 16px; margin: 30px 0; border: 1px solid #edf1f7;">
              <div style="display: flex; justify-content: space-around; text-align: center;">
                <div style="flex: 1;">
                  <div style="font-size: 32px; font-weight: 900; color: #ADFF2F; text-shadow: 1px 1px 0px rgba(0,0,0,0.1);">${platformPosts}</div>
                  <div style="font-size: 11px; text-transform: uppercase; font-weight: 800; color: #888; letter-spacing: 1px; margin-top: 5px;">New Posts Today</div>
                </div>
                ${chapterName ? `
                <div style="flex: 1; border-left: 1px solid #e1e1e1;">
                  <div style="font-size: 32px; font-weight: 900; color: #000;">${chapterPosts}</div>
                  <div style="font-size: 11px; text-transform: uppercase; font-weight: 800; color: #888; letter-spacing: 1px; margin-top: 5px;">In ${chapterName}</div>
                </div>
                ` : ''}
              </div>
            </div>
            
            <p style="text-align: center; margin-top: 40px;">
              <a href="${this.frontendUrl}/dashboard/feed" style="background-color: #ADFF2F; color: #000; padding: 18px 40px; text-decoration: none; border-radius: 12px; font-weight: 900; text-transform: uppercase; letter-spacing: 1px; font-size: 14px; box-shadow: 0 4px 14px rgba(173, 255, 47, 0.3);">
                Check out the Feed
              </a>
            </p>
            
            <div style="margin-top: 60px; padding-top: 30px; border-top: 1px solid #eee; text-align: center;">
              <p style="font-size: 10px; color: #aaa; text-transform: uppercase; font-weight: 800; letter-spacing: 2px;">The African Think Tank</p>
              <p style="font-size: 11px; color: #aaa; line-height: 1.5; margin-top: 10px;">
                You're receiving this because you're a member of the TATT professional ecosystem.<br/>
                <a href="${this.frontendUrl}/dashboard/settings" style="color: #666; text-decoration: underline;">Unsubscribe</a> or manage preferences.
              </p>
            </div>
          </div>
        `,
      });
      this.logger.log(`Daily digest email sent to ${email}`);
    } catch (error) {
      this.logger.error(`Failed to send daily digest to ${email}`, error.stack);
    }
  }

  async sendOrgWelcomeEmail(email: string, firstName: string, role: string) {
    try {
      await this.sendResendEmail({
        to: email,
        subject: `Welcome to the Leadership Team: ${firstName}`,
        html: `
          <div style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; max-width: 600px; margin: auto; padding: 40px; background-color: #000000; color: #ffffff; border-radius: 24px; border: 1px solid #333;">
            <div style="text-align: center; margin-bottom: 30px;">
              <h1 style="color: #ADFF2F; font-size: 28px; font-weight: 900; text-transform: uppercase; letter-spacing: -1px; margin: 0;">The African Think Tank</h1>
              <p style="color: #888; font-size: 12px; font-weight: 800; text-transform: uppercase; letter-spacing: 2px; margin-top: 8px;">Organizational Matrix</p>
            </div>
            
            <h2 style="font-size: 24px; font-weight: 800; margin-bottom: 20px;">Welcome to the Inner Circle, ${firstName}.</h2>
            <p style="color: #ccc; font-size: 16px; line-height: 1.6;">Your credentials as a <strong>${role.replace('_', ' ')}</strong> have been activated. You are now part of the core team driving the TATT mission forward.</p>
            
            <div style="background-color: #111; padding: 30px; border-radius: 16px; margin: 30px 0; border: 1px solid rgba(173, 255, 47, 0.1);">
              <h3 style="color: #ADFF2F; font-size: 14px; text-transform: uppercase; margin-top: 0;">Next Steps:</h3>
              <ul style="color: #ccc; padding-left: 20px; line-height: 1.8;">
                <li>Explore your administrative dashboard</li>
                <li>Collaborate with regional chapters</li>
                <li>Moderate community interactions</li>
              </ul>
            </div>
            
            <p style="text-align: center; margin-top: 40px;">
              <a href="${this.frontendUrl}/admin" style="background-color: #ADFF2F; color: #000; padding: 18px 40px; text-decoration: none; border-radius: 12px; font-weight: 900; text-transform: uppercase; letter-spacing: 1px; font-size: 14px; display: inline-block;">
                Access Admin Portal
              </a>
            </p>
            
            <div style="margin-top: 60px; padding-top: 30px; border-top: 1px solid #333; text-align: center;">
              <p style="font-size: 10px; color: #666; text-transform: uppercase; font-weight: 800; letter-spacing: 2px;">Building the future of the African professional ecosystem.</p>
            </div>
          </div>
        `,
      });
      this.logger.log(`Org Welcome email sent to ${email}`);
    } catch (error) {
      this.logger.error(`Failed to send Org Welcome email to ${email}`, error.stack);
    }
  }

  async sendCommunityWelcomeEmail(email: string, firstName: string, tier: string) {
    try {
      await this.sendResendEmail({
        to: email,
        subject: `Welcome to the TATT Ecosystem, ${firstName}`,
        html: `
          <div style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; max-width: 600px; margin: auto; padding: 40px; background-color: #ffffff; color: #000000; border-radius: 24px; border: 1px solid #e1e1e1;">
            <div style="text-align: center; margin-bottom: 30px;">
              <h1 style="color: #000; font-size: 28px; font-weight: 900; text-transform: uppercase; letter-spacing: -1px; margin: 0;">The African Think Tank</h1>
              <div style="height: 4px; width: 40px; background-color: #ADFF2F; margin: 12px auto;"></div>
            </div>
            
            <h2 style="font-size: 24px; font-weight: 800; margin-bottom: 20px;">Karibu, ${firstName}!</h2>
            <p style="color: #444; font-size: 16px; line-height: 1.6;">We are thrilled to welcome you to The African Think Tank as a <strong>${tier}</strong> member. You've joined a premier network of thinkers, doers, and leaders committed to impactful professional growth.</p>
            
            <div style="background-color: #f7f9fc; padding: 30px; border-radius: 16px; margin: 30px 0; border: 1px solid rgba(173, 255, 47, 0.2);">
              <h3 style="color: #000; font-size: 14px; text-transform: uppercase; margin-top: 0;">What's waiting for you:</h3>
              <ul style="color: #555; padding-left: 20px; line-height: 1.8;">
                <li>Global and Regional Networking</li>
                <li>Exclusive Industry Resources</li>
                <li>Collaborative Forums and Insights</li>
              </ul>
            </div>
            
            <p style="text-align: center; margin-top: 40px;">
              <a href="${this.frontendUrl}/dashboard" style="background-color: #000; color: #ADFF2F; padding: 18px 40px; text-decoration: none; border-radius: 12px; font-weight: 900; text-transform: uppercase; letter-spacing: 1px; font-size: 14px; display: inline-block;">
                Start Exploring
              </a>
            </p>
            
            <div style="margin-top: 60px; padding-top: 30px; border-top: 1px solid #eee; text-align: center;">
              <p style="font-size: 10px; color: #999; text-transform: uppercase;font-weight: 800; letter-spacing: 2px;">THE AFRICAN THINK TANK • EXCELLENCE IN CONNECTIVITY</p>
            </div>
          </div>
        `,
      });
      this.logger.log(`Community Welcome email sent to ${email}`);
    } catch (error) {
      this.logger.error(`Failed to send Community Welcome email to ${email}`, error.stack);
    }
  }

  async sendBusinessSubmissionEmail(email: string, contactName: string, businessName: string) {
    try {
      await this.sendResendEmail({
        to: email,
        subject: `Application Received: ${businessName}`,
        html: `
          <div style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; max-width: 600px; margin: auto; padding: 40px; background-color: #000000; color: #ffffff; border-radius: 24px; border: 1px solid #333;">
            <div style="text-align: center; margin-bottom: 30px;">
              <h1 style="color: #ADFF2F; font-size: 28px; font-weight: 900; text-transform: uppercase; letter-spacing: -1px; margin: 0;">The African Think Tank</h1>
              <p style="color: #888; font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: 2px; margin-top: 8px;">Business Directory Application</p>
            </div>
            
            <h2 style="font-size: 22px; font-weight: 800; margin-bottom: 20px;">We've Received Your Application, ${contactName}.</h2>
            <p style="color: #ccc; font-size: 16px; line-height: 1.6;">Thank you for your interest in the <strong>TATT Business Directory</strong>. We have successfully received the application for <strong>${businessName}</strong>.</p>
            
            <div style="background-color: #111; padding: 30px; border-radius: 16px; margin: 30px 0; border: 1px solid rgba(173, 255, 47, 0.1);">
              <h3 style="color: #ADFF2F; font-size: 14px; text-transform: uppercase; margin-top: 0;">What Happens Next?</h3>
              <p style="color: #ccc; font-size: 14px; line-height: 1.6;">Our team of specialists will review your business profile and special offers. You will receive a formal notification once your listing is approved and visible to the TATT community.</p>
            </div>
            
            <div style="margin-top: 60px; padding-top: 30px; border-top: 1px solid #333; text-align: center;">
              <p style="font-size: 10px; color: #666; text-transform: uppercase; font-weight: 800; letter-spacing: 2px;">THE AFRICAN THINK TANK • DIRECTORY MANAGEMENT</p>
            </div>
          </div>
        `,
      });
      this.logger.log(`Business submission email sent to ${email}`);
    } catch (error) {
      this.logger.error(`Failed to send business submission email to ${email}`, error.stack);
    }
  }

  async sendBusinessApprovedEmail(email: string, contactName: string, businessName: string) {
    try {
      await this.sendResendEmail({
        to: email,
        subject: `Congratulations: ${businessName} is Now Global!`,
        html: `
          <div style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; max-width: 600px; margin: auto; padding: 40px; background-color: #ffffff; color: #000000; border-radius: 24px; border: 1px solid #e1e1e1;">
            <div style="text-align: center; margin-bottom: 30px;">
              <h1 style="color: #000; font-size: 28px; font-weight: 900; text-transform: uppercase; letter-spacing: -1px; margin: 0;">The African Think Tank</h1>
              <div style="height: 4px; width: 40px; background-color: #ADFF2F; margin: 12px auto;"></div>
            </div>
            
            <h2 style="font-size: 24px; font-weight: 800; margin-bottom: 20px;">Your Business is Approved, ${contactName}!</h2>
            <p style="color: #444; font-size: 16px; line-height: 1.6;">Congratulations! <strong>${businessName}</strong> has been officially approved for the <strong>TATT Business Directory</strong>. Community members can now find your business and take advantage of your offers.</p>
            
            <div style="background-color: #f7f9fc; padding: 30px; border-radius: 16px; margin: 30px 0; border: 1px solid rgba(173, 255, 47, 0.2);">
              <h3 style="color: #000; font-size: 14px; text-transform: uppercase; margin-top: 0;">Directory Benefits:</h3>
              <ul style="color: #555; padding-left: 20px; line-height: 1.8;">
                <li>Global Visibility to TATT Members</li>
                <li>Direct Channel to Professional Leaders</li>
                <li>Branded Marketplace Listing</li>
              </ul>
            </div>
            
            <p style="text-align: center; margin-top: 40px;">
              <a href="${this.frontendUrl}/directory" style="background-color: #000; color: #ADFF2F; padding: 18px 40px; text-decoration: none; border-radius: 12px; font-weight: 900; text-transform: uppercase; letter-spacing: 1px; font-size: 14px; display: inline-block; box-shadow: 0 4px 14px rgba(0, 0, 0, 0.2);">
                View Your Listing
              </a>
            </p>
            
            <div style="margin-top: 60px; padding-top: 30px; border-top: 1px solid #eee; text-align: center;">
              <p style="font-size: 10px; color: #999; text-transform: uppercase; font-weight: 800; letter-spacing: 2px;">EXCELLENCE IN CONNECTIVITY • TATT BUSINESS NETWORK</p>
            </div>
          </div>
        `,
      });
      this.logger.log(`Business approval email sent to ${email}`);
    } catch (error) {
      this.logger.error(`Failed to send business approval email to ${email}`, error.stack);
    }
  }

  async sendBusinessDeclinedEmail(email: string, contactName: string, businessName: string, feedback?: string) {
    try {
      await this.sendResendEmail({
        to: email,
        subject: `Update on your Business Application: ${businessName}`,
        html: `
          <div style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; max-width: 600px; margin: auto; padding: 40px; background-color: #f9f9f9; color: #333; border-radius: 24px; border: 1px solid #eee;">
            <h1 style="color: #000; font-size: 24px; font-weight: 900; text-transform: uppercase; margin-bottom: 24px;">The African Think Tank</h1>
            
            <p style="font-size: 16px; line-height: 1.6;">Hello ${contactName},</p>
            <p style="font-size: 16px; line-height: 1.6;">Thank you for your interest in the TATT Business Directory. After reviewing the application for <strong>${businessName}</strong>, we have decided not to proceed with the listing at this time.</p>
            
            ${feedback ? `
            <div style="background-color: #fff; padding: 20px; border-radius: 12px; border: 1px solid #ddd; margin: 24px 0;">
              <p style="font-size: 12px; font-weight: 800; text-transform: uppercase; color: #888; margin-top: 0; margin-bottom: 8px;">Reviewer Feedback:</p>
              <p style="font-size: 14px; line-height: 1.6; color: #555; margin: 0;">${feedback}</p>
            </div>
            ` : ''}
            
            <p style="font-size: 14px; line-height: 1.6;">If you have any questions or wish to update your application, please reach out to our support team.</p>
            
            <div style="margin-top: 40px; text-align: center;">
              <a href="${this.frontendUrl}/contact" style="color: #666; font-size: 12px; font-weight: 800; text-transform: uppercase; text-decoration: underline;">Contact Support</a>
            </div>
          </div>
        `,
      });
      this.logger.log(`Business rejection email sent to ${email}`);
    } catch (error) {
      this.logger.error(`Failed to send business rejection email to ${email}`, error.stack);
    }
  }
}