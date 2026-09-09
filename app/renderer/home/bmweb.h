// BMWeb's own include for scripts of its own: the INPA builtins those
// scripts call, declared the way inpa.h declares them (parameter modes are
// what the compiler needs to pass out-parameters by reference), plus the
// two builtins BMWeb adds so a script can ask the app for a pick.
//
// Written by the BMWeb project. Nothing here is copied from BMW's headers.

// INPA builtins used by the home script
extern setmenutitle( in: string title);
extern settitle( in: string title);
extern setmenu( in: menu name);
extern setscreen( in: screen name, in: bool flag);
extern scriptchange( in: string NewScriptFile);
extern printscreen();
extern exit();
extern messagebox( in: string Title, in: string Text);
extern ftextout( in: string text, in: int row, in: int col, in: int attr, in: int mode);

// BMWeb builtins (0xE0 and up; unused by INPA)
//   bmweb_pick("chassis", "", chassis)     the app lists its chassis, the user picks one
//   bmweb_pick("module", chassis, sgbd)    the modules of that chassis, picked one's SGBD
//   bmweb_pick("vehicle", chassis, sgbd)   the chassis's whole-vehicle script, "" if none
//   A cancelled pick leaves the out-string empty.
extern bmweb_pick( in: string what, in: string arg, out: string choice);
//   bmweb_status(text)   one line from the app: cable state, version
extern bmweb_status( out: string text);
