import { describe, test } from 'vitest';

describe('parseConfig', () => {
  test.todo('should load the default file once its example detector is uncommented');
  test.todo('should refuse the default file as written, which has no detector');
  test.todo('should pass ignore_case to the detector');
  test.todo('should take trusted tools and MCP prefixes from restore');
  test.todo('should refuse an unknown key, naming its path');
  test.todo('should refuse a value of the wrong type, naming its path');
  test.todo('should refuse a TOML syntax error with its line and column');
  test.todo('should refuse intercept hosts that are not bare host names or miss the API host');
  test.todo('should refuse a bad detector, naming its index');
  test.todo('should refuse a bad MCP prefix, naming its index');
  test.todo('should refuse an empty file');
});

describe('loadConfig', () => {
  test.todo('should read config.toml from the data folder');
  test.todo('should refuse a missing file and point to amygdala init');
});
