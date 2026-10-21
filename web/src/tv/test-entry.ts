// Only injected into the explicitly enabled production E2E harness, never normal TV artifacts.
import './compat';
import './packaged';
import '../app.css';
import './tv.css';
import { installTVNavigation } from './navigation';
import { tvRuntimePlatform } from '../lib/tvRuntimePlatform';
document.documentElement.dataset.denTv = tvRuntimePlatform();
installTVNavigation();
void import('../../test/player');
