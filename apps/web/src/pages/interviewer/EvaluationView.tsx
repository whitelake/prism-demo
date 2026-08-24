import { Card, Descriptions, List, Tag, Typography } from 'antd';
import { Radar } from '@ant-design/plots';
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

// 维度 level 字符串 → 雷达图数值
// L0=0 ... L4=4；L4_pending 视为 4（与 normalizeLevel 一致）；null/证据不足 → 0
function levelToValue(level?: string | null): number {
  if (!level) return 0;
  const norm = level.replace(/_pending$/, '');
  const m = /^L([0-4])$/.exec(norm);
  return m ? Number(m[1]) : 0;
}

interface RadarPoint {
  dimension: string;
  value: number;
}

function buildRadarData(dims: DimensionItem[]): RadarPoint[] {
  return dims.map((d) => {
    const code = d.code || '';
    const name = d.name || '';
    // x 轴只显示维度代码 D1-D4（极坐标下顶部/底部 label 会竖排，短代码可读）
    // 完整维度名放到雷达图下方横向图例，避免竖排阅读体验差
    const dimension = code || name || '未知';
    return {
      dimension,
      value: levelToValue(d.level),
    };
  });
}

interface Props {
  evaluation: EvaluationSummary;
  title?: string;
  judgmentChange?: JudgmentChange | null;
}

// 维度名横向标签：绝对定位在雷达图四周
// G2 极坐标默认 startAngle=-90°（顶部），顺时针方向，4 维度均匀分布
// D1 顶部 / D2 右侧 / D3 底部 / D4 左侧
// 用绝对定位 div 显示横向文本，不受极坐标轴旋转影响
// 4 个标签都以容器中心为基准，用 translate 偏移到 L4 网格外缘附近，4 方位等距
// 容器 height=280 + padding 48 = 328px，圆心在中心，L4 半径约 110px
// 偏移 125px 让标签贴 L4 外缘约 15px
function DimensionLabels({ dimensions }: { dimensions: DimensionItem[] }) {
  if (dimensions.length < 2) return null;
  const OFFSET = 160;
  const positions = [
    { top: '50%', left: '50%', transform: `translate(-50%, calc(-50% - ${OFFSET}px))` },  // D1 顶部
    { top: '50%', left: '50%', transform: `translate(calc(-50% + ${OFFSET}px), -50%)` },  // D2 右侧
    { top: '50%', left: '50%', transform: `translate(-50%, calc(-50% + ${OFFSET}px))` },  // D3 底部
    { top: '50%', left: '50%', transform: `translate(calc(-50% - ${OFFSET}px), -50%)` },  // D4 左侧
  ];
  return (
    <>
      {dimensions.slice(0, 4).map((d, i) => (
        <div
          key={d.code || i}
          style={{
            position: 'absolute',
            ...positions[i],
            fontSize: 13,
            fontWeight: 600,
            color: '#000000',
            whiteSpace: 'nowrap',
            pointerEvents: 'none',
          }}
        >
          {d.code}
        </div>
      ))}
    </>
  );
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
          <div style={{ marginBottom: 8, textAlign: 'center' }}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              评分范围 L0 未达入门 → L4 专家
            </Text>
          </div>
          {/* 雷达图区域：浅灰背景 + 圆角 + 内 padding 留标签空间，与下方文字区隔 */}
          <div
            style={{
              position: 'relative',
              background: '#f5f5f7',
              borderRadius: 8,
              padding: 24,
              marginBottom: 16,
            }}
          >
            <Radar
              data={buildRadarData(dimensions)}
              xField="dimension"
              yField="value"
              height={360}
              padding={[36, 36, 36, 36]}
              meta={{
                y: {
                  // G2 用 domainMin/domainMax（不是 min/max）覆盖推断的 domain
                  // 不设的话 G2 会用数据最大值（如候选人最高 L3）作为 domain 上限
                  // 导致坐标轴只到 L3 而非 L4
                  domainMin: 0,
                  domainMax: 4,
                  tickCount: 5,
                  // 强制整数刻度，不出 0.5 这类小数刻度
                  // nice: false 防止 G2 把 domain 调成"漂亮"值导致 max 漂移
                  nice: false,
                  tickMethod: () => [0, 1, 2, 3, 4],
                },
              }}
              theme={{
                // G2 默认 theme 的 gridLineDash: [3,4] 让网格变虚线
                // override 成空数组强制实线
                axis: {
                  gridLineDash: [],
                  gridLineWidth: 1,
                  gridStrokeOpacity: 1,
                },
              }}
              axis={{
                // Canvas 不解析 CSS 变量，颜色必须硬编码
                x: {
                  // 隐藏 x 轴 label（G2 极坐标下顶部/底部 label 跟随轴旋转变竖排，无法横排）
                  // 改用外层绝对定位 div 显示 D1-D4 横向标签
                  labelFilter: () => false,
                  grid: true,
                  line: true,
                  gridStroke: 'rgba(0, 0, 0, 0.35)',
                  gridLineWidth: 1,
                  gridStrokeOpacity: 1,
                  lineStroke: 'rgba(0, 0, 0, 0.65)',
                  lineLineWidth: 1,
                },
                y: {
                  labelFontSize: 11,
                  labelFill: '#1d1d1f',
                  labelFormatter: (v: number) => `L${v}`,
                  // y 轴默认无 grid（同心圆），需显式开启
                  grid: true,
                  line: true,
                  gridStroke: 'rgba(0, 0, 0, 0.45)',
                  gridLineWidth: 1,
                  gridStrokeOpacity: 1,
                  lineStroke: 'rgba(0, 0, 0, 0.65)',
                  lineLineWidth: 1,
                  title: false,
                  zIndex: 1,
                  nice: false,
                },
              }}
              point={{
                visible: true,
                size: 4,
                style: { fill: '#5b8def' },
                // 数据点常驻标签：显示 L0-L4
                labels: [
                  {
                    text: 'value',
                    position: 'top',
                    formatter: (datum: { value: number }) => `L${datum.value}`,
                    fill: '#000000',
                    fontSize: 11,
                    fontWeight: 600,
                    dy: -10,
                  },
                ],
              }}
              area={{
                visible: true,
                style: {
                  fill: '#5b8def',
                  fillOpacity: 0.35,
                },
              }}
              line={{
                style: {
                  stroke: '#5b8def',
                  lineWidth: 2,
                },
              }}
              tooltip={{
                title: 'dimension',
                items: [
                  {
                    name: '等级',
                    field: 'value',
                    valueFormatter: (v: number) => `L${v}`,
                  },
                ],
              }}
            />
            {/* 维度名横向标签：绝对定位在雷达图四周，不受极坐标轴旋转影响 */}
            <DimensionLabels dimensions={dimensions} />
          </div>
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: '6px 20px',
              marginBottom: 12,
              justifyContent: 'center',
            }}
          >
            {dimensions.map((d) => (
              <Text key={d.code} style={{ fontSize: 12, color: '#3a3a3d' }}>
                {d.code} · {d.name} · {d.level}
              </Text>
            ))}
          </div>
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
