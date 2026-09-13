using System;
using BMW.Rheingold.Module.ISTA;

namespace BMW.Rheingold.Module.ISTA
{
	public class ABL_FIX_ARITH : ISTAModule
	{
		public int Status_Fehlerspeicher_v;

		private void Start()
		{
			((ISTAModule)this).LastCallingMethod = "Start";
			((ISTAModule)this).__StartStep();
			Auswertung_03_s();
		}

		private void Auswertung_03_s()
		{
			int num3 = 0;
			int num2 = 0;
			while (true)
			{
				switch (num2)
				{
				case 0:
					((ISTAModule)this).LastCallingMethod = "Auswertung_03_s";
					((ISTAModule)this).__StartStep();
					num3 = Status_Fehlerspeicher_v + 1;
					num2 = 1;
					continue;
				case 1:
					switch (num3)
					{
					case 1:
						Ohne_Fehler_04_s();
						return;
					case 2:
						Mit_Fehler_05_s();
						return;
					default:
						num2 = 9;
						continue;
					}
				case 9:
					((ISTAModule)this).__FinishStep();
					return;
				}
			}
		}

		private void Ohne_Fehler_04_s()
		{
			((ISTAModule)this).LastCallingMethod = "Ohne_Fehler_04_s";
			((ISTAModule)this).__StartStep();
			((ISTAModule)this).__FinishStep();
		}

		private void Mit_Fehler_05_s()
		{
			((ISTAModule)this).LastCallingMethod = "Mit_Fehler_05_s";
			((ISTAModule)this).__StartStep();
			((ISTAModule)this).__FinishStep();
		}
	}
}
