import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

@Entity('llm_call_log')
@Index('idx_assessment', ['assessmentId', 'purpose', 'ts'])
export class LlmCallLogEntity {
  @PrimaryGeneratedColumn({ type: 'bigint', name: 'id' })
  id!: string;

  @Column({ name: 'assessment_id', type: 'varchar', length: 36, nullable: true })
  assessmentId!: string | null;

  @Column({ type: 'varchar', length: 20 })
  purpose!: string;

  @Column({ type: 'varchar', length: 50 })
  model!: string;

  @Column({ type: 'decimal', precision: 3, scale: 2, nullable: true })
  temperature!: number | null;

  @Column({ name: 'request_messages', type: 'longtext' })
  requestMessages!: string;

  @Column({ name: 'response_raw', type: 'longtext', nullable: true })
  responseRaw!: string | null;

  @Column({ name: 'prompt_tokens', type: 'int', nullable: true })
  promptTokens!: number | null;

  @Column({ name: 'completion_tokens', type: 'int', nullable: true })
  completionTokens!: number | null;

  @Column({ name: 'latency_ms', type: 'int', nullable: true })
  latencyMs!: number | null;

  @Column({ type: 'varchar', length: 20 })
  status!: string;

  @Column({ name: 'error_msg', type: 'text', nullable: true })
  errorMsg!: string | null;

  // TypeORM 1.x 不支持 'datetime(3)' 字面量，用 datetime + precision: 3 表达毫秒
  @CreateDateColumn({
    type: 'datetime',
    precision: 3,
    name: 'ts',
    default: () => 'CURRENT_TIMESTAMP(3)',
  })
  ts!: Date;
}
