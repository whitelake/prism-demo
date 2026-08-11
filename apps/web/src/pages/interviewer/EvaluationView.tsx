import { Card, Descriptions, List, Tag, Typography } from 'antd';
import type { EvaluationSummary } from '@prism/shared';

const { Paragraph, Text } = Typography;

interface DimensionItem {
  code?: string;
  name?: string;
  level?: string;
  confidence?: number;
  insufficientEvidence?: boolean;
  reasoning?: string;
}

interface ClaimRealityGap {
  level?: string;
  description?: string;
  interpretation?: string;
}

interface AnomalySignal {
  type?: string;
  evidence?: string;
  description?: string;
}

interface RedLine {
  code?: string;
  description?: string;
}

interface OverallInfo {
  level?: string;
  track?: string;
  confidence?: number;
  reasoning?: string;
  keyUncertainties?: string[];
  recommendHumanReview?: boolean;
  humanReviewReason?: string;
}

interface JudgmentChange {
  changed?: boolean;
  fromLevel?: string;
  toLevel?: string;
  reason?: string;
  keyNewEvidence?: string[];
}

function asArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}
function asObj<T>(v: unknown): T | null {
  return v && typeof v === 'object' ? (v as T) : null;
}

interface Props {
  evaluation: EvaluationSummary;
  title?: string;
  judgmentChange?: JudgmentChange | null;
}

export function EvaluationView({ evaluation, title, judgmentChange }: Props) {
  const result = asObj<Record<string, unknown>>(evaluation.resultJson) || {};
  const dimensions = asArray<DimensionItem>(result['dimensions']);
  const claimRealityGap = asObj<ClaimRealityGap>(result['claimRealityGap']);
  const anomalySignals = asArray<AnomalySignal>(result['anomalySignals']);
  const redLines = asArray<RedLine>(result['redLines']);
  const overall = asObj<OverallInfo>(result['overall']);

  return (
    <Card
      size="small"
      title={title || `${evaluation.type} 评估`}
      extra={<Text type="secondary">{new Date(evaluation.createdAt).toLocaleString()}</Text>}
    >
      <Descriptions column={2} size="small" bordered>
        <Descriptions.Item label="等级">{evaluation.level}</Descriptions.Item>
        <Descriptions.Item label="轨道">{evaluation.track}</Descriptions.Item>
        <Descriptions.Item label="置信度">{evaluation.confidence.toFixed(2)}</Descriptions.Item>
        <Descriptions.Item label="建议人工复核">
          {evaluation.recommendHumanReview ? <Tag color="orange">是</Tag> : '否'}
          {overall?.humanReviewReason ? `（${overall.humanReviewReason}）` : ''}
        </Descriptions.Item>
      </Descriptions>

      {dimensions.length > 0 && (
        <Card type="inner" title="维度评分" size="small" style={{ marginTop: 12 }}>
          <List
            size="small"
            dataSource={dimensions}
            renderItem={(d) => (
              <List.Item style={{ flexDirection: 'column', alignItems: 'flex-start' }}>
                <div>
                  <Tag color="blue">{d.code}</Tag>
                  <Text strong>{d.name}</Text>
                  {' '}
                  <Text>{d.level}</Text>
                  {d.insufficientEvidence && <Tag color="warning">证据不足</Tag>}
                  {d.confidence != null && <Text type="secondary"> · 置信度 {d.confidence.toFixed(2)}</Text>}
                </div>
                {d.reasoning && (
                  <Paragraph type="secondary" style={{ margin: '4px 0 0' }}>
                    {d.reasoning}
                  </Paragraph>
                )}
              </List.Item>
            )}
          />
        </Card>
      )}

      {claimRealityGap && (
        <Card type="inner" title="自述与实际落差" size="small" style={{ marginTop: 12 }}>
          <Descriptions column={1} size="small">
            <Descriptions.Item label="程度">{claimRealityGap.level}</Descriptions.Item>
            {claimRealityGap.description && (
              <Descriptions.Item label="描述">{claimRealityGap.description}</Descriptions.Item>
            )}
            {claimRealityGap.interpretation && (
              <Descriptions.Item label="解读">{claimRealityGap.interpretation}</Descriptions.Item>
            )}
          </Descriptions>
        </Card>
      )}

      {anomalySignals.length > 0 && (
        <Card type="inner" title="异常信号" size="small" style={{ marginTop: 12 }}>
          <List
            size="small"
            dataSource={anomalySignals}
            renderItem={(a) => (
              <List.Item style={{ flexDirection: 'column', alignItems: 'flex-start' }}>
                <Text strong>{a.type}</Text>
                {a.evidence && <Paragraph type="secondary" style={{ margin: '4px 0' }}>证据：{a.evidence}</Paragraph>}
                {a.description && <Paragraph style={{ margin: '4px 0 0' }}>{a.description}</Paragraph>}
              </List.Item>
            )}
          />
        </Card>
      )}

      {redLines.length > 0 && (
        <Card type="inner" title="安全红线" size="small" style={{ marginTop: 12 }}>
          <List
            size="small"
            dataSource={redLines}
            renderItem={(r) => (
              <List.Item>
                <Tag color="red">{r.code}</Tag>
                <Text>{r.description}</Text>
              </List.Item>
            )}
          />
        </Card>
      )}

      {overall?.reasoning && (
        <Card type="inner" title="综合判断理由" size="small" style={{ marginTop: 12 }}>
          <Paragraph style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{overall.reasoning}</Paragraph>
          {overall.keyUncertainties && overall.keyUncertainties.length > 0 && (
            <Paragraph type="secondary" style={{ margin: '8px 0 0' }}>
              关键不确定性：{overall.keyUncertainties.join('；')}
            </Paragraph>
          )}
        </Card>
      )}

      {judgmentChange && (
        <Card type="inner" title="面试后判断变化" size="small" style={{ marginTop: 12 }}>
          {judgmentChange.changed ? (
            <>
              <Tag color="orange">{judgmentChange.fromLevel} → {judgmentChange.toLevel}</Tag>
              {judgmentChange.reason && <Paragraph style={{ margin: '8px 0 0' }}>{judgmentChange.reason}</Paragraph>}
              {judgmentChange.keyNewEvidence && judgmentChange.keyNewEvidence.length > 0 && (
                <Paragraph type="secondary" style={{ margin: '4px 0 0' }}>
                  新证据：{judgmentChange.keyNewEvidence.join('；')}
                </Paragraph>
              )}
            </>
          ) : (
            <Text type="secondary">面试后判断未变化</Text>
          )}
        </Card>
      )}
    </Card>
  );
}
