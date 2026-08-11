import { Entity, PrimaryColumn, Column } from 'typeorm';

@Entity('questionnaire_result')
export class QuestionnaireResultEntity {
  @PrimaryColumn({ type: 'varchar', length: 36, name: 'assessment_id' })
  assessmentId!: string;

  @Column({ name: 'q1', type: 'varchar', length: 50, nullable: true })
  q1!: string | null;

  @Column({ name: 'q2', type: 'json', nullable: true })
  q2!: unknown | null;

  @Column({ name: 'q3', type: 'varchar', length: 50, nullable: true })
  q3!: string | null;

  @Column({ name: 'q4', type: 'varchar', length: 50, nullable: true })
  q4!: string | null;

  @Column({ name: 'q5', type: 'varchar', length: 50, nullable: true })
  q5!: string | null;

  @Column({ name: 'submitted_at', type: 'datetime' })
  submittedAt!: Date;
}
