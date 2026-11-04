// Developer options shared by Update and Install (ferrite decision 335, UPD-21): an unsigned update file (.ffw, a
// local build of Ferrite) is refused unless this is on. Off at every start: never remembered.
class DevOpts {
  allowUnsigned = $state(false);
}

export const devOpts = new DevOpts();
