import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { parseCoordinate, parseRouteFile, readSavedPoints } from './locations';
import { Coordinate, listLocationScenarios, playRoute, runLocationScenario } from './simulators';

const RECENT_POINTS = 'emulatorPanel.recentPoints';
const RECENT_ROUTES = 'emulatorPanel.recentRoutes';
const LAST_SPEED = 'emulatorPanel.lastRouteSpeedKmh';

interface NamedPoint extends Coordinate {
  name?: string;
}

const formatPoint = (point: Coordinate) => `${point.lat.toFixed(5)}, ${point.lon.toFixed(5)}`;

function section<T extends vscode.QuickPickItem>(label: string, items: T[]): (T | vscode.QuickPickItem)[] {
  return items.length > 0 ? [{ label, kind: vscode.QuickPickItemKind.Separator }, ...items] : [];
}

export async function pickLocation(state: vscode.Memento, deviceName: string): Promise<NamedPoint | undefined> {
  type Item = vscode.QuickPickItem & { point?: NamedPoint; manual?: boolean };
  const recent = state.get<NamedPoint[]>(RECENT_POINTS, []);
  const items: (Item | vscode.QuickPickItem)[] = [
    { label: '$(edit) Enter coordinates…', manual: true, alwaysShow: true } as Item,
    ...section<Item>(
      'Recent',
      recent.map((point) => ({ label: point.name ?? formatPoint(point), description: point.name ? formatPoint(point) : undefined, point })),
    ),
    ...section<Item>(
      'Saved in Android Studio',
      readSavedPoints().map((point) => ({
        label: point.name,
        description: [formatPoint(point), point.description].filter(Boolean).join(' · '),
        point,
      })),
    ),
  ];
  const picked = (await vscode.window.showQuickPick(items, {
    title: `Set location on ${deviceName}`,
    placeHolder: 'Choose a saved point or enter coordinates',
    matchOnDescription: true,
  })) as Item | undefined;
  if (!picked) {
    return undefined;
  }
  let point = picked.point;
  if (picked.manual) {
    const text = await vscode.window.showInputBox({
      title: `Set location on ${deviceName}`,
      prompt: 'Latitude, longitude',
      placeHolder: '25.47627, 80.33955',
      ignoreFocusOut: true,
      validateInput: (value) => (parseCoordinate(value) ? undefined : 'Enter latitude and longitude, for example 25.47627, 80.33955'),
    });
    point = text ? parseCoordinate(text) : undefined;
  }
  if (point) {
    const key = formatPoint(point);
    await state.update(RECENT_POINTS, [point, ...recent.filter((entry) => formatPoint(entry) !== key)].slice(0, 8));
  }
  return point;
}

export async function pickAndPlayRoute(state: vscode.Memento, udid: string, deviceName: string): Promise<void> {
  type Item = vscode.QuickPickItem & { file?: string; browse?: boolean; scenario?: string };
  const recentFiles = state.get<string[]>(RECENT_ROUTES, []).filter((file) => fs.existsSync(file));
  const scenarios = await listLocationScenarios(udid).catch(() => [] as string[]);
  const items: (Item | vscode.QuickPickItem)[] = [
    { label: '$(folder-opened) Open GPX or KML file…', browse: true, alwaysShow: true } as Item,
    ...section<Item>(
      'Recent routes',
      recentFiles.map((file) => ({ label: path.basename(file), description: path.dirname(file), file })),
    ),
    ...section<Item>(
      'Built into the simulator',
      scenarios.map((scenario) => ({ label: scenario, scenario })),
    ),
  ];
  const picked = (await vscode.window.showQuickPick(items, {
    title: `Play route on ${deviceName}`,
    placeHolder: 'Choose a route',
  })) as Item | undefined;
  if (!picked) {
    return;
  }
  if (picked.scenario) {
    await runLocationScenario(udid, picked.scenario);
    vscode.window.showInformationMessage(`Playing "${picked.scenario}" on ${deviceName}.`);
    return;
  }

  let file = picked.file;
  if (picked.browse) {
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: false,
      filters: { Routes: ['gpx', 'kml'] },
      openLabel: 'Play Route',
      title: 'Choose a GPX or KML route',
    });
    file = uris?.[0]?.fsPath;
  }
  if (!file) {
    return;
  }
  const points = parseRouteFile(file);
  if (points.length < 2) {
    throw new Error(`${path.basename(file)} has fewer than two points, so it cannot be played as a route.`);
  }
  const speedText = await vscode.window.showInputBox({
    title: `Play ${path.basename(file)} on ${deviceName}`,
    prompt: `Speed in km/h (${points.length} points)`,
    value: String(state.get<number>(LAST_SPEED, 30)),
    ignoreFocusOut: true,
    validateInput: (value) => (Number(value) > 0 ? undefined : 'Enter a speed above 0'),
  });
  if (!speedText) {
    return;
  }
  const speedKmh = Number(speedText);
  await state.update(LAST_SPEED, speedKmh);
  await state.update(RECENT_ROUTES, [file, ...recentFiles.filter((entry) => entry !== file)].slice(0, 6));
  await playRoute(udid, points, speedKmh / 3.6);
  vscode.window.showInformationMessage(`Playing ${path.basename(file)} on ${deviceName} at ${speedKmh} km/h.`);
}
