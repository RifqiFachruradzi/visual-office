import { Composition } from 'remotion';
import { Video, FPS, SIZES, totalSeconds } from './Video.jsx';

// Contoh props untuk Remotion Studio / tes render
const SAMPLE = {
  format: '9:16',
  music: 'upbeat',
  imageUrl: null,
  sb: {
    title: 'Kenapa AI Boros Listrik?', brand: '@kantorai',
    theme: { bg1: '#0b1020', bg2: '#1c2a5a', accent: '#ffcc33', text: '#ffffff' },
    scenes: [
      { t: 'title', kicker: 'FAKTA AI', title: 'Satu pertanyaan ke ChatGPT = 10× listrik Google?', sub: 'Asal angkanya di sini 👇', sec: 3 },
      { t: 'compare', title: 'Energi per permintaan', unit: 'Wh', items: [{ label: 'ChatGPT', value: 2.9 }, { label: 'Google', value: 0.3 }], highlight: 0, sec: 5 },
      { t: 'stat', value: 16.7, decimals: 1, unit: 'ms', label: 'waktu 1 frame game 60 fps', sec: 3.5 },
      { t: 'cta', title: 'Follow buat fakta AI lainnya!', sub: '@kantorai', sec: 3 },
    ],
  },
};

export const Root = () => (
  <Composition
    id="Video"
    component={Video}
    fps={FPS}
    width={720}
    height={1280}
    durationInFrames={Math.round(totalSeconds(SAMPLE.sb) * FPS)}
    defaultProps={SAMPLE}
    calculateMetadata={({ props }) => {
      const [width, height] = SIZES[props.format] || SIZES['9:16'];
      return { width, height, durationInFrames: Math.max(FPS, Math.round(totalSeconds(props.sb) * FPS)) };
    }}
  />
);
