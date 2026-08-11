import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

// PoC 不变量 2：status 字段决定 A 结论锁定状态
// pending_interview / final_evaluating 期间，常规接口不返回 A 的等级等结论字段
// 详见 .claude/rules/poc-invariants.md 第2条
@Entity('assessment')
@Index('idx_interviewer', ['interviewerId'])
@Index('idx_token', ['token'], { unique: true })
export class AssessmentEntity {
  @PrimaryColumn({ type: 'varchar', length: 36, name: 'id' })
  id!: string;

  @Column({ name: 'interviewer_id', type: 'varchar', length: 36 })
  interviewerId!: string;

  @Column({ name: 'candidate_name', type: 'varchar', length: 50 })
  candidateName!: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  position!: string | null;

  @Column({ type: 'varchar', length: 64 })
  token!: string;

  @Column({ type: 'varchar', length: 30 })
  status!: string;

  // { stage, taskId, turnIndex, stageStartTs }
  @Column({ type: 'json', nullable: true })
  progress!: Record<string, unknown> | null;

  @CreateDateColumn({ type: 'datetime', name: 'created_at' })
  createdAt!: Date;

  @Column({ type: 'datetime', name: 'started_at', nullable: true })
  startedAt!: Date | null;

  @Column({ type: 'datetime', name: 'submitted_at', nullable: true })
  submittedAt!: Date | null;
}
