import { describe, test } from 'vitest';

describe('createInterceptor', () => {
  test.todo('should forward a request unchanged and return the reply unchanged');
  test.todo('should forward a large body byte for byte');
  test.todo('should stream a reply as it arrives');
  test.todo('should forward two requests on one connection');
  test.todo('should drop hop-by-hop headers and keep the rest');
  test.todo('should refuse an upstream it cannot verify, before sending anything');
  test.todo('should answer 502 when the upstream refuses');
  test.todo("should fail the handshake for a client that doesn't trust the CA");
  test.todo('should never speak HTTP/2');
  test.todo('should let a custom handler answer on its own');
  test.todo('should trust the system store and the bundled CAs by default');
});
