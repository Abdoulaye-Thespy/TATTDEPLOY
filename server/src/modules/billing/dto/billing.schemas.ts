import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, IsUUID, IsEmail, IsBoolean, IsIn, IsNotEmpty } from 'class-validator';
import { CommunityTier } from '../../iam/enums/roles.enum';

export class SubscriberSchema {
    @ApiProperty({ example: 'user-uuid-1', format: 'uuid' })
    @IsUUID()
    id: string;

    @ApiProperty({ example: 'Jane' })
    @IsString()
    firstName: string;

    @ApiProperty({ example: 'Doe' })
    @IsString()
    lastName: string;

    @ApiProperty({ example: 'jane.doe@example.com' })
    @IsEmail()
    email: string;

    @ApiProperty({ example: 'UBUNTU', enum: CommunityTier })
    @IsString()
    @IsNotEmpty()
    @IsEnum(CommunityTier)
    communityTier: string;

    @ApiProperty({ example: '2026-03-22T12:00:00.000Z', format: 'date-time' })
    @IsString()
    subscriptionExpiresAt: string;

    @ApiProperty({ example: 'MONTHLY', enum: ['MONTHLY', 'YEARLY'] })
    @IsIn(['MONTHLY', 'YEARLY'])
    billingCycle: string;

    @ApiProperty({ example: true })
    @IsBoolean()
    hasAutoPayEnabled: boolean;

    @ApiProperty({ example: 'COMMUNITY_MEMBER' })
    @IsString()
    systemRole: string;
}

export class RevenueMetricsSchema {
    @ApiProperty({ example: 42, description: 'Total number of active paid subscriptions.' })
    activeSubscriptions: number;

    @ApiProperty({ example: 1250.50, description: 'Calculated monthly revenue (normalised for annual plans).' })
    estimatedMonthlyRevenue: number;

    @ApiProperty({ example: 15006.00, description: 'Projected annual revenue based on current active subs.' })
    estimatedAnnualRunRate: number;

    @ApiProperty({ example: 'USD' })
    currency: string;
}

export class GenericMessageResponseSchema {
    @ApiProperty({ example: 'Operation completed successfully.' })
    message: string;
}

export class SubscribeDto {
    @ApiProperty({ example: 'UBUNTU', enum: CommunityTier })
    @IsEnum(CommunityTier)
    communityTier: string;

    @ApiProperty({ example: 'MONTHLY', enum: ['MONTHLY', 'YEARLY'] })
    @IsString()
    @IsNotEmpty()
    @IsIn(['MONTHLY', 'YEARLY'])
    billingCycle: string;

    @ApiPropertyOptional({ example: 'pm_card_visa' })
    @IsOptional()
    @IsString()
    paymentMethodId?: string;
}

export class ConfirmPaymentDto {
  @ApiProperty({ example: 'cs_test_xxxxxxxxxxxxx' })
  @IsString()
  @IsNotEmpty()
  sessionId: string;

  @ApiProperty({ example: 'UBUNTU', enum: CommunityTier })
  @IsEnum(CommunityTier)
  communityTier: string;

  @ApiProperty({ example: 'MONTHLY', enum: ['MONTHLY', 'YEARLY'] })
  @IsString()
  @IsNotEmpty()
  @IsIn(['MONTHLY', 'YEARLY'])
  billingCycle: string;
}