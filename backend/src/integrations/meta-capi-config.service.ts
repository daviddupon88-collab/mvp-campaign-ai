import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TokenCryptoService } from '../common/crypto/token-crypto.service';
import { UpdateMetaCapiConfigDto } from './dto/update-meta-capi-config.dto';

@Injectable()
export class MetaCapiConfigService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokenCrypto: TokenCryptoService,
  ) {}

  // Ne renvoie jamais accessToken déchiffré — la page de paramétrage n'a besoin que de
  // savoir si une config existe et sous quel pixel, jamais de ré-afficher le secret.
  async getStatus(organizationId: string) {
    const config = await this.prisma.metaCapiConfig.findUnique({ where: { organizationId } });
    if (!config) return { configured: false, pixelId: null, enabled: false };
    return { configured: true, pixelId: config.pixelId, enabled: config.enabled };
  }

  async update(organizationId: string, dto: UpdateMetaCapiConfigDto) {
    await this.prisma.metaCapiConfig.upsert({
      where: { organizationId },
      create: {
        organizationId,
        pixelId: dto.pixelId,
        accessToken: this.tokenCrypto.encrypt(dto.accessToken),
        enabled: dto.enabled ?? true,
      },
      update: {
        pixelId: dto.pixelId,
        accessToken: this.tokenCrypto.encrypt(dto.accessToken),
        ...(dto.enabled !== undefined ? { enabled: dto.enabled } : {}),
      },
    });
    return this.getStatus(organizationId);
  }
}
