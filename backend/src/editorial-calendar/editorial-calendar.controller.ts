import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards, BadRequestException } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { EditorialCalendarService } from './editorial-calendar.service';
import { ScheduleContentDto } from './dto/schedule-content.dto';

interface AuthUser {
  organizationId: string;
}

@Controller('calendar')
@UseGuards(JwtAuthGuard, RolesGuard)
export class EditorialCalendarController {
  constructor(private readonly calendarService: EditorialCalendarService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Query('from') from: string, @Query('to') to: string) {
    if (!from || !to) throw new BadRequestException('Paramètres "from" et "to" requis (dates ISO)');
    return this.calendarService.listByRange(user.organizationId, new Date(from), new Date(to));
  }

  @Post()
  @Roles('EDITOR', 'MARKETING_MANAGER', 'ADMIN', 'OWNER')
  schedule(@CurrentUser() user: AuthUser, @Body() dto: ScheduleContentDto) {
    return this.calendarService.schedule(user.organizationId, {
      contentPieceId: dto.contentPieceId,
      socialConnectionId: dto.socialConnectionId,
      scheduledAt: new Date(dto.scheduledAt),
    });
  }

  @Patch(':id/reschedule')
  @Roles('EDITOR', 'MARKETING_MANAGER', 'ADMIN', 'OWNER')
  reschedule(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body('scheduledAt') scheduledAt: string) {
    return this.calendarService.reschedule(user.organizationId, id, new Date(scheduledAt));
  }

  @Delete(':id')
  @Roles('EDITOR', 'MARKETING_MANAGER', 'ADMIN', 'OWNER')
  cancel(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.calendarService.cancel(user.organizationId, id);
  }
}
