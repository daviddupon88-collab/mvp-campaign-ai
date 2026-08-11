import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PlatformAdminGuard } from '../common/guards/platform-admin.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { SupportService } from './support.service';
import { CreateTicketDto, ReplyTicketDto, StaffReplyTicketDto } from './dto/support.dto';

interface AuthUser {
  userId: string;
  email: string;
  organizationId: string;
  isPlatformAdmin: boolean;
}

@Controller('support')
@UseGuards(JwtAuthGuard)
export class SupportController {
  constructor(private readonly supportService: SupportService) {}

  @Post('tickets')
  createTicket(@CurrentUser() user: AuthUser, @Body() dto: CreateTicketDto) {
    return this.supportService.createTicket(user.userId, user.organizationId, dto.subject, dto.message, dto.priority);
  }

  @Get('tickets')
  listMine(@CurrentUser() user: AuthUser) {
    return this.supportService.listForUser(user.userId);
  }

  @Get('tickets/:id')
  getOne(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.supportService.getById(user.userId, id, user.isPlatformAdmin);
  }

  @Post('tickets/:id/reply')
  reply(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: ReplyTicketDto) {
    return this.supportService.replyAsCustomer(user.userId, id, dto.message);
  }

  // --- Vue équipe Campaign-ai (accès plateforme, hors isolation par tenant) ---

  @Get('staff/tickets')
  @UseGuards(PlatformAdminGuard)
  listAllForStaff(@Query('status') status?: string) {
    return this.supportService.listAllForStaff({ status });
  }

  @Post('staff/tickets/:id/reply')
  @UseGuards(PlatformAdminGuard)
  replyAsStaff(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: StaffReplyTicketDto) {
    return this.supportService.replyAsStaff(user.email, id, dto.message, dto.status);
  }
}
