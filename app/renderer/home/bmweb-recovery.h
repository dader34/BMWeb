// The include of BMWeb's DME recovery script: the INPA builtins it
// calls, declared the way inpa.h declares them (parameter modes are what
// the compiler needs to pass out-parameters by reference), and the two
// builtins BMWeb adds so the script can run the recovery and show it.
//
// Written by the BMWeb project. Nothing here is copied from BMW's headers.

// INPA builtins used by the recovery script
extern setmenutitle( in: string title);
extern settitle( in: string title);
extern setmenu( in: menu name);
extern setscreen( in: screen name, in: bool flag);
extern exit();
extern ftextout( in: string text, in: int row, in: int col, in: int attr, in: int mode);

// BMWeb builtins (0xE0 and up; unused by INPA)
//   bmweb_recovery("ident")     identify the DME
//   bmweb_recovery("watch")     the same, quietly, and only when no DME is
//                               identified and a try is due: for a screen
//                               that looks for the DME by itself
//   bmweb_recovery("recover")   fetch the newest program and data for it
//                               and flash them, after asking
//   Both start the step and return at once; the screen shows it running.
extern bmweb_recovery( in: string what);
//   bmweb_recovery_read(field, text)   one field of the recovery, as text:
//     state     "" nothing read yet, "busy" a step is running, "ok" the
//               DME is fine, "recover" it needs its program, "silent" it
//               did not answer, "other" it is not this recovery's DME
//     title     the recovery's name, for the title bar ("MS45.1 recovery")
//     headline  one line saying the same in words
//     dme vin program data assembly status   what the DME identified as
//     newest    the program and data a recovery would flash, once found
//     step      what the running step is doing
//     bar       its progress, drawn
extern bmweb_recovery_read( in: string field, out: string text);
