import { Subtitle } from '../types';

export const formatTime = (seconds: number): string => {
  const date = new Date(0);
  date.setMilliseconds(seconds * 1000);
  return date.toISOString().substring(11, 23).replace('.', ',');
};

export const generateSRT = (subtitles: Subtitle[]): string => {
  return subtitles
    .sort((a, b) => a.start - b.start)
    .map((sub, index) => {
      return `${index + 1}\n${formatTime(sub.start)} --> ${formatTime(sub.end)}\n${sub.text}\n`;
    })
    .join('\n');
};
