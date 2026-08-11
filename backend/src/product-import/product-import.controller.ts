import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ProductImportService } from './product-import.service';
import { ConnectStoreDto } from './dto/connect-store.dto';

@Controller('product-import')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ProductImportController {
  constructor(private readonly productImportService: ProductImportService) {}

  @Get('stores')
  listStores(@CurrentUser() user: { organizationId: string }) {
    return this.productImportService.listStores(user.organizationId);
  }

  @Post('stores')
  @Roles('ADMIN', 'OWNER')
  connectStore(@CurrentUser() user: { organizationId: string }, @Body() dto: ConnectStoreDto) {
    return this.productImportService.connectStore({ organizationId: user.organizationId, ...dto });
  }

  @Post('stores/:id/sync')
  @Roles('EDITOR', 'MARKETING_MANAGER', 'ADMIN', 'OWNER')
  syncCatalog(@CurrentUser() user: { organizationId: string }, @Param('id') storeConnectionId: string) {
    return this.productImportService.syncCatalog(user.organizationId, storeConnectionId);
  }

  @Get('products')
  listImportedProducts(
    @CurrentUser() user: { organizationId: string },
    @Query('storeConnectionId') storeConnectionId?: string,
  ) {
    return this.productImportService.listImportedProducts(user.organizationId, storeConnectionId);
  }
}
