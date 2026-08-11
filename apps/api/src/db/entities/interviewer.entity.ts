import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

@Entity('interviewer')
@Index('idx_account', ['account'], { unique: true })
export class InterviewerEntity {
  @PrimaryColumn({ type: 'varchar', length: 36, name: 'id' })
  id!: string;

  @Column({ type: 'varchar', length: 50 })
  name!: string;

  @Column({ type: 'varchar', length: 50 })
  account!: string;

  @Column({ name: 'password_hash', type: 'varchar', length: 255 })
  passwordHash!: string;

  @CreateDateColumn({ type: 'datetime', name: 'created_at' })
  createdAt!: Date;
}
