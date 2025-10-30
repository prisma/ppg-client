# Test Infrastructure

This directory contains all test files for the PPG client library.

## Running Tests

### Run all tests once
```bash
pnpm test
```

### Run tests with UI
```bash
pnpm test:ui
```

### Generate coverage reports
```bash
pnpm test:coverage
```

### Run coverage in watch mode
```bash
pnpm test:coverage:watch
```

## Coverage Reports

Coverage reports are generated in the following formats:
- **LCOV**: `coverage/lcov.info` - Used by CI tools and IDEs
- **HTML**: `coverage/index.html` - Human-readable report, open in browser

The coverage directory is ignored by git as configured in `.gitignore`.

## Writing Tests

Test files should follow the naming convention: `*.test.ts` or `*.spec.ts`

Example test structure:

```typescript
import { describe, it, expect } from 'vitest';

describe('Feature Name', () => {
  it('should do something', () => {
    expect(result).toBe(expected);
  });
});
```

## Configuration

Test configuration is in [vitest.config.ts](../vitest.config.ts) in the project root.

Coverage thresholds are set to 80% for:
- Lines
- Functions
- Branches
- Statements

## CI Integration

Tests will be integrated with GitHub Actions to:
- Run on pull requests
- Run as pre-push hooks
- Check coverage thresholds
- Generate coverage reports
