import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

// CMS minimal pour la documentation utilisateur — contrairement au reste de l'API, ce
// contenu doit pouvoir changer au fil de l'eau (une équipe support/contenu édite des
// articles) sans nécessiter de déploiement de code, d'où un stockage en base plutôt que
// des fichiers Markdown versionnés dans le dépôt.
@Injectable()
export class HelpService {
  constructor(private readonly prisma: PrismaService) {}

  // Public : seuls les articles publiés sont visibles, jamais les brouillons.
  async listPublished(category?: string) {
    return this.prisma.helpArticle.findMany({
      where: { published: true, ...(category ? { category } : {}) },
      orderBy: { title: 'asc' },
      select: { id: true, slug: true, title: true, category: true, updatedAt: true },
    });
  }

  async getBySlug(slug: string) {
    const article = await this.prisma.helpArticle.findUnique({ where: { slug } });
    if (!article || !article.published) throw new NotFoundException('Article introuvable');
    return article;
  }

  // Recherche simple par correspondance textuelle — suffisant à l'échelle d'un centre
  // d'aide (quelques dizaines à centaines d'articles), pas besoin d'un moteur de recherche
  // dédié (Elasticsearch/Algolia) à ce stade.
  async search(query: string) {
    return this.prisma.helpArticle.findMany({
      where: {
        published: true,
        OR: [
          { title: { contains: query, mode: 'insensitive' } },
          { body: { contains: query, mode: 'insensitive' } },
        ],
      },
      select: { id: true, slug: true, title: true, category: true },
      take: 20,
    });
  }

  // --- Administration du contenu (équipe Campaign-ai) ---

  async listAllForStaff() {
    return this.prisma.helpArticle.findMany({ orderBy: { updatedAt: 'desc' } });
  }

  async create(data: { slug: string; title: string; body: string; category?: string }) {
    return this.prisma.helpArticle.create({ data });
  }

  async update(id: string, data: { title?: string; body?: string; category?: string; published?: boolean }) {
    const article = await this.prisma.helpArticle.findUnique({ where: { id } });
    if (!article) throw new NotFoundException('Article introuvable');
    return this.prisma.helpArticle.update({ where: { id }, data });
  }

  async delete(id: string) {
    const article = await this.prisma.helpArticle.findUnique({ where: { id } });
    if (!article) throw new NotFoundException('Article introuvable');
    return this.prisma.helpArticle.delete({ where: { id } });
  }
}
