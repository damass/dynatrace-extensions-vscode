import {
  Heading,
  Flex,
  Text,
  TimeseriesChart,
  Timeseries,
  TimeseriesChartConfig,
  CodeSnippet,
  Container,
  Divider,
  Code,
  InformationOverlay,
} from "@dynatrace/strato-components-preview";
import { WarningIcon } from "@dynatrace/strato-icons";
import React from "react";
import { MetricSeriesCollection, MetricSeries } from "src/app/interfaces/metricResultsPanel";

interface MetricResultsPanelProps {
  data: MetricSeriesCollection[];
}

const toTimeseriesData = (metricSeries: MetricSeries[], metricId: string): Timeseries[] => {
  return metricSeries.slice(0, 5).map(({ dimensions, timestamps, values }) => ({
    name: dimensions.length > 0 ? dimensions.join(", ") : metricId.split(":")[0],
    datapoints: timestamps.map((ts, i) => {
      const end = new Date(ts);
      const start = i > 0 ? new Date(timestamps[i - 1]) : new Date(ts);
      return { start, end, value: values[i] };
    }),
  }));
};

export const MetricResultsPanel = ({ data }: MetricResultsPanelProps) => {
  const { metricId, data: series, warnings } = data[0];

  return (
    <Flex flexDirection='column' gap={16}>
      <Heading level={1}>Metric selector results</Heading>
      <Flex flexDirection='column' paddingTop={20}>
        <Text>Metric selector: </Text>
        <CodeSnippet showLineNumbers={false} language='sql'>
          {metricId}
        </CodeSnippet>
      </Flex>
      {!!warnings && (
        <Container as={Flex} alignItems='center' variant='emphasized' color='warning'>
          <WarningIcon size='large' />
          <Divider orientation='vertical' />
          <Text>{warnings}</Text>
        </Container>
      )}
      {series.length > 0 && (
        <Flex flexDirection='column'>
          <Flex justifyContent='space-between' paddingTop={8}>
            <Text>Timeseries data:</Text>
            {series.length > 5 && (
              <InformationOverlay>
                <InformationOverlay.Trigger />
                <InformationOverlay.Content>
                  The metric results included more series, however, for readability we are only
                  displaying the first 5.
                </InformationOverlay.Content>
              </InformationOverlay>
            )}
          </Flex>
          <TimeseriesChartConfig value={{ legend: { position: "bottom", resizable: false } }}>
            <TimeseriesChart data={toTimeseriesData(series, metricId)} />
          </TimeseriesChartConfig>
          {Object.entries(series[0].dimensionMap).length > 0 && (
            <Flex flexDirection='column'>
              <Text>Dimension map:</Text>
              {Object.entries(series[0].dimensionMap).map(([key, value]) => (
                <Flex key={`${key}-${value}`} marginLeft={20}>
                  <Code>{key}</Code>
                  <Text>{value}</Text>
                </Flex>
              ))}
            </Flex>
          )}
        </Flex>
      )}
    </Flex>
  );
};
