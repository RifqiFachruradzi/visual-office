import { registerRoot } from 'remotion';
// font tiap paket visual (dibundel, tidak butuh internet saat render)
import '@fontsource/montserrat/700.css';
import '@fontsource/montserrat/900.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/700.css';
import '@fontsource/inter/800.css';
import '@fontsource/space-grotesk/500.css';
import '@fontsource/space-grotesk/700.css';
import '@fontsource/playfair-display/700.css';
import '@fontsource/playfair-display/700-italic.css';
import '@fontsource/playfair-display/800.css';
import '@fontsource/fredoka/500.css';
import '@fontsource/fredoka/700.css';
import { Root } from './Root.jsx';

registerRoot(Root);
