using System;
using BMW.Rheingold.Module.ISTA;

namespace BMW.Rheingold.Module.ISTA
{
	public class ABL_FIX_OPAQUE : ISTAModule
	{
		public string Steuergeraet_v;

		private void Start()
		{
			((ISTAModule)this).LastCallingMethod = "Start";
			((ISTAModule)this).__StartStep();
			switch (1 == 1)
			{
			case false:
			case true:
				break;
			default:
				Steuergeraet_v = "DDE control unit";
				Lebend_01_s();
				return;
			}
			Tot_99_s();
		}

		private void Lebend_01_s()
		{
			((ISTAModule)this).LastCallingMethod = "Lebend_01_s";
			((ISTAModule)this).__StartStep();
			((ISTAModule)this).__FinishStep();
		}

		private void Tot_99_s()
		{
			((ISTAModule)this).LastCallingMethod = "Tot_99_s";
			((ISTAModule)this).__StartStep();
			((ISTAModule)this).__FinishStep();
		}
	}
}
