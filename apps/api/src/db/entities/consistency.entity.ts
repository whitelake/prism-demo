import { Entity, PrimaryColumn, Column } from 'typeorm';

// 三方一致性：提交B并产出C后自动计算
// max_level_gap 归一化规则：
//   L0=0, L1=1, L2=2, L3=3, L4=4
//   L3_pending=3, L4_pending=4（pending 视为对应等级参与比较，
//   "是否 pending" 不进入 gap 计算）
// a_eq_b / b_eq_c / a_eq_c：仅在数值相等时为 true，
//   pending 与确定等级视为相等（A=L3_pending, C=L3 → a_eq_c=true, gap=0）
// B 的 level 字段不含 pending，无需归一化特殊处理
@Entity('consistency')
export class ConsistencyEntity {
  @PrimaryColumn({ type: 'varchar', length: 36, name: 'assessment_id' })
  assessmentId!: string;

  @Column({ name: 'level_a', type: 'varchar', length: 15, nullable: true })
  levelA!: string | null;

  @Column({ name: 'level_b', type: 'varchar', length: 5, nullable: true })
  levelB!: string | null;

  @Column({ name: 'level_c', type: 'varchar', length: 15, nullable: true })
  levelC!: string | null;

  @Column({ name: 'a_eq_b', type: 'boolean', nullable: true })
  aEqB!: boolean | null;

  @Column({ name: 'b_eq_c', type: 'boolean', nullable: true })
  bEqC!: boolean | null;

  @Column({ name: 'a_eq_c', type: 'boolean', nullable: true })
  aEqC!: boolean | null;

  @Column({ name: 'max_level_gap', type: 'int', nullable: true })
  maxLevelGap!: number | null;

  @Column({ name: 'computed_at', type: 'datetime', nullable: true })
  computedAt!: Date | null;
}
