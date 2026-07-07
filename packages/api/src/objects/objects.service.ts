import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type {
  OntologyObject,
  OntologyLink,
  CreateObjectInput,
  UpdateObjectInput,
  ObjectQuery,
  CreateLinkInput,
} from '@clearview/shared';
import { ObjectsRepository } from './objects.repository';
import { RealtimeService } from './realtime.service';

@Injectable()
export class ObjectsService {
  constructor(
    private readonly repo: ObjectsRepository,
    private readonly realtime: RealtimeService,
  ) {}

  async create(tenantId: string, input: CreateObjectInput): Promise<OntologyObject> {
    if (!input || typeof input.type !== 'string' || input.type.trim() === '') {
      throw new BadRequestException('`type` is required.');
    }
    const obj = await this.repo.create(tenantId, input);
    this.realtime.publish({
      kind: 'created',
      tenantId,
      objectId: obj.id,
      type: obj.type,
      at: obj.updatedAt,
    });
    return obj;
  }

  async get(tenantId: string, id: string): Promise<OntologyObject> {
    const obj = await this.repo.get(tenantId, id);
    if (!obj) throw new NotFoundException('object not found');
    return obj;
  }

  list(tenantId: string, query: ObjectQuery): Promise<OntologyObject[]> {
    return this.repo.list(tenantId, query);
  }

  async update(tenantId: string, id: string, input: UpdateObjectInput): Promise<OntologyObject> {
    const obj = await this.repo.update(tenantId, id, input ?? {});
    if (!obj) throw new NotFoundException('object not found');
    this.realtime.publish({
      kind: 'updated',
      tenantId,
      objectId: obj.id,
      type: obj.type,
      at: obj.updatedAt,
    });
    return obj;
  }

  async remove(tenantId: string, id: string): Promise<void> {
    const existing = await this.repo.get(tenantId, id);
    if (!existing) throw new NotFoundException('object not found');
    await this.repo.softDelete(tenantId, id);
    this.realtime.publish({
      kind: 'deleted',
      tenantId,
      objectId: id,
      type: existing.type,
      at: new Date().toISOString(),
    });
  }

  createLink(tenantId: string, input: CreateLinkInput): Promise<OntologyLink> {
    if (!input || !input.fromObject || !input.toObject || !input.relation) {
      throw new BadRequestException('`fromObject`, `toObject`, and `relation` are required.');
    }
    return this.repo.createLink(tenantId, input);
  }
}
