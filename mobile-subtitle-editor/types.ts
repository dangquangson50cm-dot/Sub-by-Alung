export interface Subtitle {
  id: string;
  start: number; // in seconds
  end: number;   // in seconds
  text: string;
}

export interface WaveformMetrics {
  pixelsPerSecond: number;
  height: number;
}

export interface SubtitleStyle {
  fontFamily: string;
  fontSize: number;    // Percentage of video height (e.g., 5 = 5%)
  strokeWidth: number; // Percentage of font size (e.g., 20 = 20%)
  fontWeight: string;  // 'normal', 'bold', '900'
  color: string;       // Hex color
}