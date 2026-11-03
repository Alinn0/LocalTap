/**
 * File System Access API 的最小类型补充。
 * TS 5.6 的 lib.dom 已有 `FileSystemFileHandle`，但缺少 `showOpenFilePicker`
 * 与句柄的 `queryPermission`，这里按规范补齐实际用到的部分。
 */

interface OpenFilePickerAcceptType {
  description?: string;
  accept: Record<string, string | string[]>;
}

interface OpenFilePickerOptions {
  multiple?: boolean;
  excludeAcceptAllOption?: boolean;
  startIn?: FileSystemHandle | string;
  suggestedName?: string;
  types?: OpenFilePickerAcceptType[];
}

type FileHandlePermissionDescriptor = { mode?: 'read' | 'readwrite' };

interface FileSystemHandlePermissionMixin {
  queryPermission?(descriptor?: FileHandlePermissionDescriptor): Promise<PermissionState>;
  requestPermission?(descriptor?: FileHandlePermissionDescriptor): Promise<PermissionState>;
}

interface Window {
  showOpenFilePicker?(options?: OpenFilePickerOptions): Promise<FileSystemFileHandle[]>;
}
