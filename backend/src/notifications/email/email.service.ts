import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface SendEmailParams {
  to: string;
  subject: string;
  html: string;
}

// Avant ce chantier, aucun email n'était réellement envoyé nulle part dans l'application —
// TeamsService.invite() se contentait de retourner le token d'invitation dans la réponse
// API, à charge pour le frontend de l'afficher. Ce service comble ce trou.
//
// Choix de fournisseur : Resend (API REST simple, un seul appel HTTP, pas de SDK lourd à
// intégrer) — mais l'interface `send()` reste indépendante de ce choix, cohérente avec le
// pattern déjà établi ailleurs (AiProvider, SocialAdapter) : remplacer Resend par un autre
// fournisseur ne toucherait que ce fichier. Sans EMAIL_PROVIDER_API_KEY configurée, les
// emails sont journalisés en structured log plutôt qu'envoyés — même principe que
// AI_MODE=mock, pour permettre de développer/tester sans compte fournisseur.
@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private readonly apiKey: string | undefined;
  private readonly fromAddress: string;

  constructor(private readonly config: ConfigService) {
    this.apiKey = this.config.get<string>('EMAIL_PROVIDER_API_KEY');
    this.fromAddress = this.config.get<string>('EMAIL_FROM_ADDRESS', 'Campaign-ai <notifications@campaign-ai.example.com>');
  }

  async send(params: SendEmailParams): Promise<void> {
    if (!this.apiKey) {
      this.logger.log(`[EMAIL SIMULÉ] À: ${params.to} — Sujet: ${params.subject}`);
      return;
    }

    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: this.fromAddress, to: params.to, subject: params.subject, html: params.html }),
      });
      if (!res.ok) {
        this.logger.error(`Échec d'envoi d'email à ${params.to}: ${res.status} ${await res.text()}`);
      }
    } catch (error) {
      // Best-effort, comme AuditService : un email non envoyé ne doit jamais faire échouer
      // l'action métier qui l'a déclenché (ex: une invitation reste valide même si le mail échoue).
      this.logger.error(`Échec d'envoi d'email à ${params.to}: ${error}`);
    }
  }
}
