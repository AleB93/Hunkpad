// Entry point: the settings are loaded before the app reads any of them.
import { loadSettings } from "./settings";

loadSettings().finally(() => import("./main"));
