import { Module, Global } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Resend } from 'resend';
import { MailService } from './mail.service';

@Global()
@Module({
  imports: [ConfigModule], // only need ConfigModule for env vars
  providers: [
    MailService,
    {
      provide: Resend, // the injection token
      useFactory: (configService: ConfigService) => {
        const apiKey = configService.get<string>('RESEND_API_KEY');
        if (!apiKey) {
          throw new Error('RESEND_API_KEY is not defined');
        }
        return new Resend(apiKey);
      },
      inject: [ConfigService],
    },
  ],
  exports: [MailService], // export MailService, not Resend (unless needed)
})
export class MailModule {}