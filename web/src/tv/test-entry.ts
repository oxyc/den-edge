// Only injected into the explicitly enabled production E2E harness, never normal TV artifacts.
import './compat';
import '../app.css';
import './tv.css';
import { installTVNavigation } from './navigation';
document.documentElement.dataset.denTv = __DEN_TV_PLATFORM__;
installTVNavigation();
void import('../../test/player');
