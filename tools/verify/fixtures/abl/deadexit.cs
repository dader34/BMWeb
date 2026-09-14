using System;
using BMW.Rheingold.Module.ISTA;

namespace BMW.Rheingold.Module.ISTA
{
	public class ABL_FIX_DEADEXIT : ISTAModule
	{
		private void Start()
		{
			((ISTAModule)this).LastCallingMethod = "Start";
			((ISTAModule)this).__StartStep();
			Verteiler_07_s();
		}

		private void Verteiler_07_s()
		{
			int num = 0;
			int num2 = 0;
			int num5 = 0;
			while (true)
			{
				switch (num2)
				{
				case 0:
					((ISTAModule)this).LastCallingMethod = "Verteiler_07_s";
					((ISTAModule)this).__StartStep();
					num = 4;
					num2 = 5;
					continue;
				case 5:
					((ISTAModule)this).__FinishStep();
					num5 = num;
					num2 = 6;
					continue;
				case 6:
					switch (num5)
					{
					case 4:
						Erreicht_08_s();
						return;
					case 9:
						Nie_Erreicht_09_s();
						return;
					default:
						return;
					}
				}
			}
		}

		private void Erreicht_08_s()
		{
			((ISTAModule)this).LastCallingMethod = "Erreicht_08_s";
			((ISTAModule)this).__StartStep();
			((ISTAModule)this).__FinishStep();
		}

		private void Nie_Erreicht_09_s()
		{
			((ISTAModule)this).LastCallingMethod = "Nie_Erreicht_09_s";
			((ISTAModule)this).__StartStep();
			((ISTAModule)this).__FinishStep();
		}
	}
}
