import type { ThemeConfig } from 'antd';

const token = {
  colorPrimary: '#5B8DEF',
  colorInfo: '#5B8DEF',
  colorSuccess: '#5C9472',
  colorWarning: '#C99A4A',
  colorError: '#C9625E',
  colorLink: '#5B8DEF',
  colorBgContainer: '#FFFFFF',
  colorBgElevated: '#FFFFFF',
  colorBgLayout: '#FAFAFA',
  colorBgSpotlight: '#FFFFFF',
  colorText: '#1D1D1F',
  colorTextSecondary: '#5A5A5E',
  colorTextTertiary: '#86868B',
  colorTextQuaternary: '#A1A1A6',
  colorBorder: '#D2D2D7',
  colorBorderSecondary: '#E5E5EA',
  colorSplit: '#E5E5EA',
  colorBgBlur: 'rgba(255, 255, 255, 0.72)',
  borderRadius: 10,
  borderRadiusLG: 14,
  borderRadiusSM: 8,
  fontSize: 14,
  fontSizeLG: 16,
  controlHeight: 38,
  controlHeightLG: 44,
  controlHeightSM: 28,
  boxShadow: '0 1px 2px rgba(0,0,0,0.04), 0 4px 16px rgba(0,0,0,0.06)',
  boxShadowSecondary: '0 2px 8px rgba(0,0,0,0.06), 0 8px 32px rgba(0,0,0,0.08)',
  boxShadowTertiary: '0 1px 4px rgba(0,0,0,0.04)',
  wireframe: false,
  fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'PingFang SC', 'Microsoft YaHei', system-ui, sans-serif",
} as const;

const components: ThemeConfig['components'] = {
  Card: {
    colorBgContainer: '#FFFFFF',
    borderRadiusLG: 14,
    boxShadowTertiary: '0 1px 4px rgba(0,0,0,0.04)',
  },
  Button: {
    borderRadius: 10,
    controlHeight: 38,
    primaryShadow: '0 1px 0 rgba(255,255,255,0.6) inset, 0 2px 8px rgba(91,141,239,0.18)',
    defaultShadow: '0 1px 2px rgba(0,0,0,0.04)',
    paddingInline: 18,
  },
  Input: {
    colorBgContainer: '#FFFFFF',
    borderRadius: 10,
    activeShadow: '0 0 0 2px rgba(91,141,239,0.2)',
  },
  InputNumber: {
    colorBgContainer: '#FFFFFF',
  },
  Select: {
    colorBgContainer: '#FFFFFF',
    borderRadius: 10,
  },
  Tag: {
    borderRadiusSM: 6,
    defaultBg: 'rgba(0,0,0,0.03)',
    defaultColor: '#5A5A5E',
  },
  Table: {
    headerBg: '#FAFAFA',
    rowHoverBg: '#F5F5F7',
    borderColor: '#E5E5EA',
    headerColor: '#5A5A5E',
  },
  Modal: {
    contentBg: '#FFFFFF',
    headerBg: '#FFFFFF',
    titleColor: '#1D1D1F',
  },
  Progress: {
    defaultColor: '#5B8DEF',
    remainingColor: 'rgba(91,141,239,0.12)',
  },
  Alert: {
    borderRadiusLG: 10,
  },
  Form: {
    labelColor: '#5A5A5E',
  },
  Descriptions: {
    colorText: '#1D1D1F',
    colorSplit: '#E5E5EA',
  },
  Tabs: {
    itemColor: '#5A5A5E',
    itemHoverColor: '#1D1D1F',
    itemSelectedColor: '#5B8DEF',
    inkBarColor: '#5B8DEF',
  },
  Radio: {
    colorPrimary: '#5B8DEF',
  },
  Checkbox: {
    colorPrimary: '#5B8DEF',
  },
  Menu: {
    colorBgContainer: 'transparent',
  },
};

export const theme: ThemeConfig = {
  token,
  components,
};
