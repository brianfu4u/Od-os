import { Module } from '@nestjs/common';
import { ObjectsModule } from '../objects/objects.module';
import { ScansController } from './scans.controller';
import { ScansService } from './scans.service';
import { ScansRepository } from './scans.repository';

/**
 * T-05 · patient scans (feat/business-flow-p0, Stage 2). Additive NEW module: writes only the
 * append-only patient_scans ledger + a neutral `patient.scanned` event. It never touches the objects
 * triplet's business state, flow_id/flow_state, or S2 verify().
 *
 * Imports ObjectsModule for RealtimeService (a thin broadcast-only SSE nudge to the manager board).
 */
@Module({
  imports: [ObjectsModule],
  controllers: [ScansController],
  providers: [ScansService, ScansRepository],
})
export class ScansModule {}
