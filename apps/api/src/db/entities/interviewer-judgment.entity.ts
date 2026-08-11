import { Entity, PrimaryColumn, Column } from 'typeorm';

// 面试官独立判断 B
// 草稿转正规则：POST /judgment 时把 transcript_draft 复制到 transcript，
// 随后 transcript 不可再编辑；transcript_draft 可保留也可清空。
// 列表/报告接口读取 transcript；草稿编辑接口读写 transcript_draft。
@Entity('interviewer_judgment')
export class InterviewerJudgmentEntity {
  @PrimaryColumn({ type: 'varchar', length: 36, name: 'assessment_id' })
  assessmentId!: string;

  // B 不含 pending（面试官直接给确定等级），故 length=5
  @Column({ type: 'varchar', length: 5 })
  level!: string;

  @Column({ type: 'varchar', length: 20 })
  track!: string;

  @Column({ type: 'text' })
  reason!: string;

  @Column({ type: 'longtext' })
  transcript!: string;

  @Column({ name: 'transcript_draft', type: 'longtext', nullable: true })
  transcriptDraft!: string | null;

  @Column({ name: 'submitted_at', type: 'datetime', nullable: true })
  submittedAt!: Date | null;
}
