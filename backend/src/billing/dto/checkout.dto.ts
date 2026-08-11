import { IsIn, IsString, IsOptional, IsBoolean } from 'class-validator';

export class CreateCheckoutDto {
  @IsIn(['starter', 'growth', 'business'])
  plan: string;

  @IsString()
  successUrl: string;

  @IsString()
  cancelUrl: string;
}

export class ChangePlanDto {
  @IsIn(['starter', 'growth', 'business'])
  plan: string;
}

export class CancelSubscriptionDto {
  // Sans ces décorateurs, ValidationPipe({ whitelist:true }) supprime silencieusement
  // ce champ de tout payload entrant (bug réel corrigé : `immediate` n'atteignait jamais
  // le service, la résiliation immédiate demandée par le client était toujours ignorée).
  @IsOptional()
  @IsBoolean()
  immediate?: boolean;
}

export class CreateCreditPackCheckoutDto {
  @IsIn(['small', 'medium', 'large'])
  pack: string;

  @IsString()
  successUrl: string;

  @IsString()
  cancelUrl: string;
}
