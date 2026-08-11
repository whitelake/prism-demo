import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  Unique,
} from 'typeorm';

// 评估结果：A（无面试记录时产出，可能为 L3_pending / L4_pending）
// 和 C（提交B后产出，结合面试记录重新判定，得到最终确定等级）
// 详见 architecture.md 5.1 / PRD 关于 A/C 的章节
@Entity('evaluation')
@Unique('uk_assessment_type', ['assessmentId', 'type'])
export class EvaluationEntity {
  @PrimaryColumn({ type: 'varchar', length: 36, name: 'id' })
  id!: string;

  @Column({ name: 'assessment_id', type: 'varchar', length: 36 })
  assessmentId!: string;

  // A | C
  @Column({ type: 'char', length: 1 })
  type!: string;

  @Column({ name: 'result_json', type: 'json' })
  resultJson!: unknown;

  // L2 | L3_pending | L4_pending | L3 | L4 ...（PRD 等级定义）
  @Column({ type: 'varchar', length: 15 })
  level!: string;

  @Column({ type: 'varchar', length: 20 })
  track!: string;

  @Column({ type: 'decimal', precision: 3, scale: 2 })
  confidence!: number;

  @Column({ name: 'recommend_human_review', type: 'boolean' })
  recommendHumanReview!: boolean;

  @CreateDateColumn({ type: 'datetime', name: 'created_at' })
  createdAt!: Date;
}
