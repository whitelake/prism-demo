import { Entity, PrimaryColumn, Column, CreateDateColumn } from 'typeorm';

@Entity('outline')
export class OutlineEntity {
  @PrimaryColumn({ type: 'varchar', length: 36, name: 'assessment_id' })
  assessmentId!: string;

  @Column({ name: 'result_json', type: 'json', nullable: true })
  resultJson!: unknown | null;

  // success | blacklist_failed
  @Column({ type: 'varchar', length: 20 })
  status!: string;

  @CreateDateColumn({ type: 'datetime', name: 'created_at' })
  createdAt!: Date;
}
