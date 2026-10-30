// The Agent Host Protocol versions Pocket Pilot speaks, offered in the `initialize` handshake.
import { SUPPORTED_PROTOCOL_VERSIONS, compareProtocolVersions } from '../../vendor/ahp/types/index.js';

/**
 * Releases of VS Code speak different versions, and each accepts only its own (by caret range): VS Code
 * 1.141 speaks 0.10.0, a development version between the protocol's 0.9.0 and 1.0.0 releases; earlier
 * releases speak 0.9.0 or older. VS Code 1.143 speaks 1.1.0, which adds one action to 1.0.0: a chat's own
 * settings (`chat/configChanged`, handled by the store). The library is a superset of all of them except
 * that action, but lists only its release baselines (1.0.0 and 0.9.0), so the others are added here.
 * Most preferred first.
 */
const ALSO = ['1.1.0', '0.10.0', '0.9.0', '0.8.0', '0.7.0', '0.6.0', '0.5.2', '0.5.1'];

export const PROTOCOL_VERSIONS = Object.freeze([...new Set([...SUPPORTED_PROTOCOL_VERSIONS, ...ALSO])].sort((a, b) => compareProtocolVersions(b, a)));
