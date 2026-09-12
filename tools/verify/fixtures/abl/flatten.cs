using System;
using BMW.Rheingold.Module.ISTA;

namespace BMW.Rheingold.Module.ISTA
{
	public class ABL_FIX_FLATTEN : ISTAModule
	{
		public string SG_gruppe_v;

		public int SELEKT;

		private void Start()
		{
			int num = 0;
			while (true)
			{
				switch (num)
				{
				case 3:
					Erste_01_s();
					return;
				case 0:
					((ISTAModule)this).LastCallingMethod = "Start";
					((ISTAModule)this).__StartStep();
					SG_gruppe_v = "D_MOTOR";
					num = 3;
					continue;
				}
				break;
			}
		}

		private void Erste_01_s()
		{
			int num = 0;
			while (true)
			{
				switch (num)
				{
				case 7:
					((ISTAModule)this).__FinishStep();
					Zweite_02_s();
					return;
				case 0:
					((ISTAModule)this).LastCallingMethod = "Erste_01_s";
					((ISTAModule)this).__StartStep();
					num = 7;
					continue;
				}
				break;
			}
		}

		private void Zweite_02_s()
		{
			((ISTAModule)this).LastCallingMethod = "Zweite_02_s";
			((ISTAModule)this).__StartStep();
			((ISTAModule)this).__FinishStep();
		}
	}
}
