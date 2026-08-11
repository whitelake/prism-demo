import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  Index,
} from 'typeorm';

// PoC 不变量 1：mode=tool 行的 stage_or_task 必须 = 当前任务，
// 不允许跨任务查询工具模式历史
@Entity('dialogue_log')
@Index('idx_assessment_mode', ['assessmentId', 'mode', 'stageOrTask', 'ts'])
export class DialogueLogEntity {
  @PrimaryGeneratedColumn({ type: 'bigint', name: 'id' })
  id!: string;

  @Column({ name: 'assessment_id', type: 'varchar', length: 36 })
  assessmentId!: string;

  // examiner | tool
  @Column({ type: 'varchar', length: 10 })
  mode!: string;

  // S1.1 | S1.2 | S1.3 | T1 | T2
  @Column({ name: 'stage_or_task', type: 'varchar', length: 10 })
  stageOrTask!: string;

  @Column({ name: 'turn_index', type: 'int' })
  turnIndex!: number;

  // ai | candidate | system_card
  // system_card 行：content 存 JSON {variant, title, body}，由 getState 重建为前端卡片
  // 不变量 1：mode=tool 行的 stage_or_task 必须 = 当前任务；system_card 行 mode=tool
  //          也按所属任务存储，刷新时不破坏隔离
  @Column({ type: 'varchar', length: 12 })
  role!: string;

  @Column({ type: 'mediumtext' })
  content!: string;

  // 仅 role=ai 且 mode=examiner；其他情况为 null
  // PoC 不变量 3：signals 不进入任何前端常规 API，仅用于状态机/落库/导出
  @Column({ type: 'json', nullable: true })
  signals!: unknown | null;

  // 仅 role=candidate；其他情况为 null
  @Column({ name: 'response_interval_sec', type: 'int', nullable: true })
  responseIntervalSec!: number | null;

  // TypeORM 1.x 不支持 'datetime(3)' 字面量，用 datetime + precision: 3
  @Column({ type: 'datetime', precision: 3 })
  ts!: Date;
}
