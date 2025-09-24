const VERBOSE = /^(1|true|yes)$/i.test(String(process.env.VERBOSE_MODE || ''));

function ts() {
    return new Date()
        .toISOString()
        .replace('T', ' ')
        .replace(/\.\d{3}Z$/, 'Z');
}

function base(level, msg, meta) {
    let prefix = ''
    switch (level) {
        case 'ERROR': prefix='[ERROR] '; break
        case 'WARN': prefix='[WARN] '; break
        case 'INFO': prefix='[INFO] '; break
        case 'VERBOSE': prefix='[VERBOSE] '; break
        case '':
        case undefined:
        case null:
            prefix='' // no mostrar nada cuando viene vacío
            break
        default:
            prefix = `[${level}] `
    }
    const line = prefix + msg + (meta ? ` ${typeof meta==='string'?meta:JSON.stringify(meta)}` : '')
    if (level === 'ERROR') console.error(line)
    else if (level === 'WARN') console.warn(line)
    else console.log(line)
}

export const log = {
    info: (m, meta) => base('', m, meta),
    warn: (m, meta) => base('WARN', m, meta),
    error: (m, meta) => base('ERROR', m, meta),
    verbose: (m, meta) => {
        if (VERBOSE) base('VERBOSE', m, meta);
    },
};

export const isVerbose = () => VERBOSE;
