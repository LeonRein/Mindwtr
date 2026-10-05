import React from 'react';
import { Platform } from 'react-native';
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import CaptureQuickScreen from '../app/(drawer)/(tabs)/capture-quick';

const originalPlatform = Platform.OS;

const harness = vi.hoisted(() => ({
  params: {} as { mode?: string; autoRecord?: string },
  defaultCaptureMethod: 'text',
  openQuickCapture: vi.fn(),
  replace: vi.fn(),
  logInfo: vi.fn(),
}));

vi.mock('expo-router', () => ({
  useLocalSearchParams: () => harness.params,
  useRouter: () => ({ replace: harness.replace }),
}));
vi.mock('@react-navigation/native', () => ({
  useFocusEffect: (callback: () => void | (() => void)) => React.useEffect(callback, [callback]),
}));
vi.mock('@mindwtr/core', () => ({
  useTaskStore: () => ({ settings: { gtd: { defaultCaptureMethod: harness.defaultCaptureMethod } } }),
}));
vi.mock('../contexts/quick-capture-context', () => ({
  useQuickCapture: () => ({ openQuickCapture: harness.openQuickCapture }),
}));
vi.mock('../lib/app-log', () => ({ logInfo: harness.logInfo }));

describe('capture-quick route', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    Platform.OS = 'android';
    harness.params = {};
    harness.defaultCaptureMethod = 'text';
  });
  afterEach(() => {
    Platform.OS = originalPlatform;
    vi.useRealTimers();
  });

  it('opens an editable text sheet without recording even when the default is audio', () => {
    harness.params = { mode: 'text' };
    harness.defaultCaptureMethod = 'audio';
    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(<CaptureQuickScreen />);
    });
    expect(harness.openQuickCapture).not.toHaveBeenCalled();
    act(() => { vi.runAllTimers(); });
    expect(harness.openQuickCapture).toHaveBeenCalledExactlyOnceWith({ autoRecord: false, preserveDraft: true });
    expect(harness.replace).toHaveBeenCalledExactlyOnceWith('/inbox');
    expect(harness.logInfo).toHaveBeenCalledExactlyOnceWith('Android detailed capture opened', {
      scope: 'capture',
      extra: { releaseCheck: 'v1.3.4/android-detailed-capture' },
    });
    act(() => tree.unmount());
  });

  it.each([
    [{ mode: 'audio' }, 'text', true],
    [{}, 'audio', true],
    [{ autoRecord: 'true' }, 'text', true],
    [{ mode: 'text', autoRecord: 'true' }, 'audio', false],
  ])('retains existing audio/default behavior for %j', (params, defaultMethod, autoRecord) => {
    harness.params = params;
    harness.defaultCaptureMethod = defaultMethod;
    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(<CaptureQuickScreen />);
    });
    act(() => { vi.runAllTimers(); });
    expect(harness.openQuickCapture).toHaveBeenCalledExactlyOnceWith({ autoRecord, preserveDraft: true });
    act(() => tree.unmount());
  });

  it('cancels a pending sheet open when the route loses focus before the deferred call', () => {
    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(<CaptureQuickScreen />);
    });
    act(() => tree.unmount());
    act(() => { vi.runAllTimers(); });
    expect(harness.openQuickCapture).not.toHaveBeenCalled();
    expect(harness.replace).not.toHaveBeenCalled();
    expect(harness.logInfo).not.toHaveBeenCalled();
  });
});
