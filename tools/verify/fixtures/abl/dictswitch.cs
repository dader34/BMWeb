using System;
using System.Collections.Generic;
using BMW.Rheingold.Module.ISTA;

namespace BMW.Rheingold.Module.ISTA
{
	public class ABL_FIX_DICTSWITCH : ISTAModule
	{
		public string f_SELEKT_ORT_NR_HEX;

		private void Start()
		{
			((ISTAModule)this).LastCallingMethod = "Start";
			((ISTAModule)this).__StartStep();
			Verzweigung_02_s();
		}

		private void Verzweigung_02_s()
		{
			int value = default(int);
			int num2 = 0;
			while (true)
			{
				switch (num2)
				{
				case 0:
					((ISTAModule)this).LastCallingMethod = "Verzweigung_02_s";
					((ISTAModule)this).__StartStep();
					<PrivateImplementationDetails>{2BC23616-0CB6-4744-AF39-842F9F76B69C}.$$method0x600000a-1 = new Dictionary<string, int>(3)
					{
						{ "4550", 0 },
						{ "4551", 1 },
						{ "4552", 2 }
					};
					num2 = 1;
					continue;
				case 1:
					if (<PrivateImplementationDetails>{2BC23616-0CB6-4744-AF39-842F9F76B69C}.$$method0x600000a-1.TryGetValue(f_SELEKT_ORT_NR_HEX, out value))
					{
						num2 = 2;
						continue;
					}
					num2 = 9;
					continue;
				case 2:
					switch (value)
					{
					case 0:
						MN_Leitung_10_s();
						return;
					case 1:
						MN_Sensor_11_s();
						return;
					case 2:
						WAW_Tausch_12_s();
						return;
					}
					num2 = 9;
					continue;
				case 9:
					((ISTAModule)this).__FinishStep();
					return;
				}
			}
		}

		private void MN_Leitung_10_s()
		{
			((ISTAModule)this).LastCallingMethod = "MN_Leitung_10_s";
			((ISTAModule)this).__StartStep();
			((ISTAModule)this).__FinishStep();
		}

		private void MN_Sensor_11_s()
		{
			((ISTAModule)this).LastCallingMethod = "MN_Sensor_11_s";
			((ISTAModule)this).__StartStep();
			((ISTAModule)this).__FinishStep();
		}

		private void WAW_Tausch_12_s()
		{
			((ISTAModule)this).LastCallingMethod = "WAW_Tausch_12_s";
			((ISTAModule)this).__StartStep();
			((ISTAModule)this).__FinishStep();
		}
	}
}
