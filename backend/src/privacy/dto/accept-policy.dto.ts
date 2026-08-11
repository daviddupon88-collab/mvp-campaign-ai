import { IsIn } from 'class-validator';

export class AcceptPolicyDto {
  @IsIn(['TERMS_OF_SERVICE', 'PRIVACY_POLICY', 'AI_DISCLOSURE'])
  policyType: string;
}
