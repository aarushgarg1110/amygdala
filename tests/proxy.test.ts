import { describe, test } from 'vitest';

describe('startProxy', () => {
  test.todo('should listen on 127.0.0.1 only and report its port');
  test.todo('should tunnel a host it does not intercept, bytes unchanged');
  test.todo('should pass a megabyte of binary through unchanged');
  test.todo('should answer 502 when the upstream refuses, and keep serving');
  test.todo('should refuse anything but CONNECT with 405');
  test.todo('should refuse a malformed target with 400');
  test.todo('should hand an intercept host to the hook and never tunnel it');
  test.todo('should close one side of a tunnel when the other hangs up');
  test.todo('should stop listening and end open tunnels on close');
});
