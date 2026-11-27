// LoadMach9: connection pool contract
export function validatePoolConfig(cfg) {
  if (!cfg || typeof cfg.maxConn !== 'number' || cfg.maxConn < 1) {
    throw new Error('invalid pool config: maxConn must be >= 1');
  }
}
