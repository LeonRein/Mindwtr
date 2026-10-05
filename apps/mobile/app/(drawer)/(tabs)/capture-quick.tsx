import { useCallback } from 'react';
import { Platform } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useFocusEffect } from '@react-navigation/native';
import { useTaskStore } from '@mindwtr/core';

import { useQuickCapture } from '../../../contexts/quick-capture-context';
import { logInfo } from '../../../lib/app-log';

export default function CaptureQuickScreen() {
  const { openQuickCapture } = useQuickCapture();
  const router = useRouter();
  const params = useLocalSearchParams<{ mode?: string; autoRecord?: string }>();
  const { settings } = useTaskStore();

  useFocusEffect(
    useCallback(() => {
      const defaultCapture = settings.gtd?.defaultCaptureMethod ?? 'text';
      const mode = typeof params.mode === 'string' ? params.mode : undefined;
      const autoParam = typeof params.autoRecord === 'string' ? params.autoRecord : undefined;
      const autoRecord = mode
        ? mode === 'audio'
        : autoParam
          ? autoParam === '1' || autoParam.toLowerCase() === 'true'
          : defaultCapture === 'audio';

      // Defer one frame so the tab layout/provider is fully focused before opening the sheet.
      const timer = setTimeout(() => {
        openQuickCapture({ autoRecord, preserveDraft: true });
        if (Platform.OS === 'android' && mode === 'text') {
          void logInfo('Android detailed capture opened', {
            scope: 'capture',
            extra: { releaseCheck: 'v1.3.4/android-detailed-capture' },
          });
        }
        router.replace('/inbox');
      }, 0);

      return () => clearTimeout(timer);
    }, [openQuickCapture, params.autoRecord, params.mode, router, settings.gtd?.defaultCaptureMethod])
  );

  return null;
}
